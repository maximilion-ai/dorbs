//! Runs a program to its end or its deadline and keeps what it printed, cut to size.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

/// What the service's own children see of its environment: no secret reaches git or docker unless a
/// caller passes it.
const BASE_ENV: [&str; 5] = ["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "DOCKER_HOST"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessResult {
    pub stdout: String,
    pub stderr: String,
    /// None when the process was killed at its deadline or by a signal.
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// Whether either stream lost its middle to the cap.
    pub truncated: bool,
}

pub enum Env<'a> {
    /// The caller's whole environment, for commands a person runs in their own checkout.
    Inherit,
    /// [`BASE_ENV`] and these.
    Clean(&'a [(String, String)]),
}

pub struct Spec<'a> {
    pub program: &'a str,
    pub args: &'a [&'a str],
    pub cwd: &'a Path,
    pub env: Env<'a>,
    pub timeout: Duration,
    /// Bytes of each stream kept from its start, and as many from its end.
    pub keep: usize,
    pub stdin: Option<Vec<u8>>,
}

pub async fn run(spec: Spec<'_>) -> std::io::Result<ProcessResult> {
    let mut command = Command::new(spec.program);
    command
        .args(spec.args)
        .current_dir(spec.cwd)
        .kill_on_drop(true)
        .process_group(0);
    if let Env::Clean(extra) = spec.env {
        command.env_clear();
        for name in BASE_ENV {
            if let Ok(value) = std::env::var(name) {
                command.env(name, value);
            }
        }
        command.envs(extra.iter().map(|(k, v)| (k, v)));
    }
    command
        .stdin(if spec.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let pid = child.id();
    if let (Some(input), Some(mut stdin)) = (spec.stdin, child.stdin.take()) {
        tokio::spawn(async move {
            let _ = stdin.write_all(&input).await;
        });
    }
    let mut stdout = tokio::spawn(keep(child.stdout.take().expect("piped stdout"), spec.keep));
    let mut stderr = tokio::spawn(keep(child.stderr.take().expect("piped stderr"), spec.keep));
    // The deadline covers the streams too: a process the run left may hold them open.
    let ended = tokio::time::timeout(spec.timeout, async {
        let status = child.wait().await;
        let (out, err) = tokio::join!(&mut stdout, &mut stderr);
        (status, out, err)
    })
    .await;
    let kept = |joined: Result<std::io::Result<(String, bool)>, tokio::task::JoinError>| {
        joined
            .ok()
            .and_then(Result::ok)
            .unwrap_or((String::new(), true))
    };
    let (status, timed_out, (stdout, cut_out), (stderr, cut_err)) = match ended {
        Ok((status, out, err)) => (Some(status?), false, kept(out), kept(err)),
        Err(_) => {
            // The whole process group, so a shell's children go with it.
            if let Some(pid) = pid {
                // SAFETY: killpg only sends a signal to the group the child leads.
                unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };
            }
            let _ = child.wait().await;
            (None, true, drained(stdout).await, drained(stderr).await)
        }
    };
    Ok(ProcessResult {
        stdout,
        stderr,
        exit_code: status.and_then(|status| status.code()),
        timed_out,
        truncated: cut_out || cut_err,
    })
}

/// What a stream's reader kept; empty when something outside the process group still holds it.
async fn drained(
    mut reader: tokio::task::JoinHandle<std::io::Result<(String, bool)>>,
) -> (String, bool) {
    match tokio::time::timeout(Duration::from_secs(5), &mut reader).await {
        Ok(Ok(Ok(kept))) => kept,
        _ => {
            reader.abort();
            (String::new(), true)
        }
    }
}

/// Reads a stream to its end, keeping its first and last `limit` bytes.
async fn keep(mut stream: impl AsyncRead + Unpin, limit: usize) -> std::io::Result<(String, bool)> {
    let mut head: Vec<u8> = Vec::new();
    let mut tail: std::collections::VecDeque<u8> = std::collections::VecDeque::new();
    let mut cut: u64 = 0;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let mut chunk = &buffer[..read];
        if head.len() < limit {
            let taken = chunk.len().min(limit - head.len());
            head.extend_from_slice(&chunk[..taken]);
            chunk = &chunk[taken..];
        }
        tail.extend(chunk);
        while tail.len() > limit {
            let over = tail.len() - limit;
            tail.drain(..over);
            cut += over as u64;
        }
    }
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
    let tail: Vec<u8> = tail.into_iter().collect();
    Ok(if cut == 0 {
        head.extend(tail);
        (text(&head), false)
    } else {
        (
            format!("{}\n[… {cut} bytes cut …]\n{}", text(&head), text(&tail)),
            true,
        )
    })
}
