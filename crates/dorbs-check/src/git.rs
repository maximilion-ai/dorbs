//! The repos' bare caches on the host, fetched with each repo's read token, and the environments'
//! work trees checked out of them with an index of their own.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use globset::GlobSet;
use serde::{Deserialize, Serialize};

use crate::process::{self, Env, ProcessResult, Spec};
use crate::protocol::{Change, CommitSha, RelativePath, RepoId};

pub enum FetchError {
    UnknownCommit,
    Failed(String),
}

/// No user or system config, so no credential helper, and no prompt: a fetch has its token or fails.
fn git_env(token: Option<&str>) -> Vec<(String, String)> {
    let mut env = vec![
        ("GIT_CONFIG_NOSYSTEM".to_owned(), "1".to_owned()),
        ("GIT_CONFIG_GLOBAL".to_owned(), "/dev/null".to_owned()),
        ("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned()),
    ];
    if let Some(token) = token {
        // In the environment rather than -c, so the token is on no command line.
        let basic =
            base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
        env.push(("GIT_CONFIG_COUNT".to_owned(), "1".to_owned()));
        env.push(("GIT_CONFIG_KEY_0".to_owned(), "http.extraHeader".to_owned()));
        env.push((
            "GIT_CONFIG_VALUE_0".to_owned(),
            format!("Authorization: Basic {basic}"),
        ));
    }
    env
}

async fn git(
    cwd: &Path,
    args: &[&str],
    env: &[(String, String)],
    stdin: Option<Vec<u8>>,
) -> ProcessResult {
    let spec = Spec {
        program: "git",
        args,
        cwd,
        env: Env::Clean(env),
        timeout: Duration::from_secs(600),
        keep: 1 << 30,
        stdin,
    };
    process::run(spec)
        .await
        .unwrap_or_else(|error| ProcessResult {
            stdout: String::new(),
            stderr: format!("git did not start: {error}"),
            exit_code: None,
            timed_out: false,
            truncated: false,
        })
}

pub struct Caches {
    dir: PathBuf,
    /// Fetches into one repo's cache take turns, because git locks the cache's shallow file.
    turns: Mutex<HashMap<RepoId, Arc<tokio::sync::Mutex<()>>>>,
}

impl Caches {
    pub fn new(data_dir: &Path) -> Caches {
        Caches {
            dir: data_dir.join("git"),
            turns: Mutex::new(HashMap::new()),
        }
    }

    pub fn git_dir(&self, repo: &RepoId) -> PathBuf {
        self.dir.join(format!("{repo}.git"))
    }

    /// Fetches `commit` into the repo's bare cache unless it holds it already; answers the cache.
    pub async fn fetch(
        &self,
        repo: &RepoId,
        url: &str,
        commit: &CommitSha,
        token: Option<&str>,
    ) -> Result<PathBuf, FetchError> {
        let turn = self
            .turns
            .lock()
            .expect("the turns")
            .entry(repo.clone())
            .or_default()
            .clone();
        let _turn = turn.lock().await;
        let dir = self.git_dir(repo);
        std::fs::create_dir_all(&dir).map_err(|e| FetchError::Failed(e.to_string()))?;
        let env = git_env(None);
        if git(&dir, &["rev-parse", "--is-bare-repository"], &env, None)
            .await
            .exit_code
            != Some(0)
        {
            git(&dir, &["init", "--bare", "--quiet"], &env, None).await;
        }
        let object = format!("{commit}^{{commit}}");
        if git(&dir, &["cat-file", "-e", &object], &env, None)
            .await
            .exit_code
            == Some(0)
        {
            return Ok(dir);
        }
        let args = [
            "fetch",
            "--quiet",
            "--depth",
            "1",
            "--no-tags",
            "--no-write-fetch-head",
            url,
            commit.as_str(),
        ];
        let result = git(&dir, &args, &git_env(token), None).await;
        if result.exit_code == Some(0) {
            return Ok(dir);
        }
        let unknown = [
            "not our ref",
            "couldn't find remote ref",
            "unadvertised object",
        ];
        let stderr = result.stderr.to_lowercase();
        Err(if unknown.iter().any(|needle| stderr.contains(needle)) {
            FetchError::UnknownCommit
        } else {
            FetchError::Failed(
                result
                    .stderr
                    .chars()
                    .rev()
                    .take(4000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect(),
            )
        })
    }
}

/// A commit's paths, and the content of those `reads` matches.
pub async fn files(
    git_dir: &Path,
    commit: &CommitSha,
    reads: &GlobSet,
) -> Result<(Vec<RelativePath>, HashMap<String, String>), String> {
    let env = git_env(None);
    let listed = git(
        git_dir,
        &["ls-tree", "-r", "-z", "--name-only", commit.as_str()],
        &env,
        None,
    )
    .await;
    if listed.exit_code != Some(0) {
        return Err(format!("git ls-tree failed: {}", listed.stderr));
    }
    let paths: Vec<RelativePath> = (listed.stdout.split('\0'))
        .filter_map(|p| RelativePath::try_from(p).ok())
        .collect();
    let wanted: Vec<&RelativePath> = paths
        .iter()
        .filter(|path| reads.is_match(path.as_str()))
        .collect();
    let input: String = wanted
        .iter()
        .map(|path| format!("{commit}:{path}\n"))
        .collect();
    let mut child = tokio::process::Command::new("git")
        .args(["cat-file", "--batch"])
        .current_dir(git_dir)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(input.as_bytes()).await;
    });
    let output = child.wait_with_output().await.map_err(|e| e.to_string())?;
    Ok((paths.clone(), read_batch(&output.stdout, &wanted)))
}

/// Reads `git cat-file --batch` output: a header line, the object's bytes and a newline, per input.
fn read_batch(output: &[u8], names: &[&RelativePath]) -> HashMap<String, String> {
    let mut files = HashMap::new();
    let mut at = 0;
    for name in names {
        let Some(newline) = output[at..].iter().position(|&b| b == b'\n') else {
            break;
        };
        let header = String::from_utf8_lossy(&output[at..at + newline]).into_owned();
        at += newline + 1;
        let fields: Vec<&str> = header.split(' ').collect();
        let Some(size) = (fields.get(1) == Some(&"blob"))
            .then(|| fields.get(2))
            .flatten()
            .and_then(|s| s.parse::<usize>().ok())
        else {
            continue;
        };
        let end = (at + size).min(output.len());
        files.insert(
            name.to_string(),
            String::from_utf8_lossy(&output[at..end]).into_owned(),
        );
        at = end + 1;
    }
    files
}

/// An environment's working tree: checked out from a repo's bare cache with an index of its own.
pub struct Tree {
    pub git_dir: PathBuf,
    pub work_tree: PathBuf,
    /// The tree's index, outside the work tree, so nothing a check runs can touch it.
    pub index_file: PathBuf,
}

/// Why a change could not be laid over the tree.
#[derive(Debug, PartialEq, Eq)]
pub enum Overlaid {
    /// These paths go through a symbolic link of the tree or replace a directory.
    Unsafe(Vec<RelativePath>),
    /// The tree is not fit to write to.
    Broken(String),
}

/// What an overlay changed, so `restore` can take it off again, also after a restart.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Overlay {
    pub touched: Vec<RelativePath>,
    /// Directories the overlay made for new files, deepest first.
    pub created: Vec<String>,
}

impl Tree {
    fn dirty_file(&self) -> PathBuf {
        let mut name = self.index_file.clone().into_os_string();
        name.push(".dirty");
        PathBuf::from(name)
    }

    /// Refuses a tree whose root is not a real directory: a run can put a link to anywhere on the
    /// host in its place, which git and the file operations here would follow.
    fn guard(&self) -> Result<(), String> {
        match std::fs::symlink_metadata(&self.work_tree) {
            Ok(meta) if meta.is_dir() => Ok(()),
            _ => Err(format!(
                "{} is not a directory of its own",
                self.work_tree.display()
            )),
        }
    }

    async fn git(&self, args: &[&str]) -> Result<String, String> {
        self.guard()?;
        let (git_dir, work_tree) = (
            self.git_dir.to_string_lossy(),
            self.work_tree.to_string_lossy(),
        );
        let mut full = vec!["--git-dir", &git_dir, "--work-tree", &work_tree];
        full.extend_from_slice(args);
        let mut env = git_env(None);
        env.push((
            "GIT_INDEX_FILE".to_owned(),
            self.index_file.to_string_lossy().into_owned(),
        ));
        let result = git(&self.work_tree, &full, &env, None).await;
        match result.exit_code {
            Some(0) => Ok(result.stdout),
            code => Err(format!(
                "git {} exited {code:?}: {}",
                args[0], result.stderr
            )),
        }
    }

    /// Checks `commit` out into an empty work tree, or only its files at `paths`.
    pub async fn materialize(
        &self,
        commit: &CommitSha,
        paths: Option<&[RelativePath]>,
    ) -> Result<(), String> {
        let _ = std::fs::remove_file(&self.index_file);
        let _ = std::fs::remove_file(self.dirty_file());
        std::fs::create_dir_all(&self.work_tree).map_err(|e| e.to_string())?;
        self.guard()?;
        match paths {
            None => self
                .git(&["read-tree", "--reset", "-u", commit.as_str()])
                .await
                .map(drop),
            Some(paths) => {
                self.git(&["read-tree", commit.as_str()]).await?;
                if paths.is_empty() {
                    return Ok(());
                }
                let mut args = vec!["checkout-index", "-f", "--"];
                args.extend(paths.iter().map(|p| p.as_str()));
                self.git(&args).await.map(drop)
            }
        }
    }

    /// Moves the tree from one commit to another, touching only the files that differ.
    pub async fn move_to(&self, from: &CommitSha, to: &CommitSha) -> Result<(), String> {
        if from == to {
            return Ok(());
        }
        if self
            .git(&["read-tree", "-m", "-u", from.as_str(), to.as_str()])
            .await
            .is_err()
        {
            self.git(&["read-tree", "--reset", "-u", to.as_str()])
                .await?;
        }
        Ok(())
    }

    /// Writes a change into the tree in place. A path through a symbolic link of the tree, or one
    /// that replaces a directory, is refused, so no write leaves it.
    pub fn overlay(&self, change: &Change) -> Result<Overlay, Overlaid> {
        self.guard().map_err(Overlaid::Broken)?;
        let all: Vec<&RelativePath> = change
            .deleted
            .iter()
            .chain(change.files.iter().map(|f| &f.path))
            .collect();
        let mut unsafe_paths: Vec<RelativePath> = Vec::new();
        for path in &all {
            let names: Vec<&str> = path.split('/').collect();
            for end in 1..names.len() {
                match std::fs::symlink_metadata(self.work_tree.join(names[..end].join("/"))) {
                    Err(_) => break,
                    Ok(meta) if !meta.is_dir() => {
                        unsafe_paths.push((*path).clone());
                        break;
                    }
                    Ok(_) => {}
                }
            }
            if std::fs::symlink_metadata(self.work_tree.join(path.as_str()))
                .is_ok_and(|m| m.is_dir())
            {
                unsafe_paths.push((*path).clone());
            }
        }
        if !unsafe_paths.is_empty() {
            unsafe_paths.sort();
            unsafe_paths.dedup();
            return Err(Overlaid::Unsafe(unsafe_paths));
        }
        let mut created: Vec<String> = Vec::new();
        for file in &change.files {
            let mut dir = file.path.as_str();
            while let Some((parent, _)) = dir.rsplit_once('/') {
                if std::fs::symlink_metadata(self.work_tree.join(parent)).is_err()
                    && !created.iter().any(|c| c == parent)
                {
                    created.push(parent.to_owned());
                }
                dir = parent;
            }
        }
        created.sort_by_key(|dir| std::cmp::Reverse(dir.matches('/').count()));
        let overlay = Overlay {
            touched: all.into_iter().cloned().collect(),
            created,
        };
        let _ = std::fs::write(
            self.dirty_file(),
            serde_json::to_vec(&overlay).expect("an overlay serializes"),
        );
        for path in &change.deleted {
            let _ = std::fs::remove_file(self.work_tree.join(path.as_str()));
        }
        for file in &change.files {
            let target = self.work_tree.join(file.path.as_str());
            if let Some(parent) = target.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            // A symbolic link in the file's place is replaced, never followed.
            let _ = std::fs::remove_file(&target);
            let written = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target);
            if let Ok(mut out) = written {
                use std::io::Write;
                let _ = out.write_all(file.content.as_bytes());
            }
        }
        Ok(overlay)
    }

    /// Removes whatever a run left in place of a directory on the way to `path`, a link above all,
    /// so nothing that follows deletes or writes outside the tree.
    fn clear_way(&self, path: &str) {
        let names: Vec<&str> = path.split('/').collect();
        for end in 1..names.len() {
            let prefix = self.work_tree.join(names[..end].join("/"));
            match std::fs::symlink_metadata(&prefix) {
                Err(_) => return,
                // remove_file removes a link itself, never what it points to.
                Ok(meta) if !meta.is_dir() => {
                    let _ = std::fs::remove_file(&prefix);
                    return;
                }
                Ok(_) => {}
            }
        }
    }

    /// Takes an overlay off: its new files and directories go, and every tracked file that differs
    /// from the index, the overlay's or one a run changed, gets the index's content back.
    pub async fn restore(&self, overlay: &Overlay) -> Result<(), String> {
        self.guard()?;
        for path in overlay
            .touched
            .iter()
            .map(|p| p.as_str())
            .chain(overlay.created.iter().map(String::as_str))
        {
            self.clear_way(path);
        }
        if !overlay.touched.is_empty() {
            let mut args = vec!["ls-files", "-z", "--"];
            args.extend(overlay.touched.iter().map(|p| p.as_str()));
            let tracked: HashSet<String> = self
                .git(&args)
                .await?
                .split('\0')
                .map(str::to_owned)
                .collect();
            for path in overlay
                .touched
                .iter()
                .filter(|p| !tracked.contains(p.as_str()))
            {
                let target = self.work_tree.join(path.as_str());
                if std::fs::symlink_metadata(&target).is_ok_and(|m| m.is_dir()) {
                    let _ = std::fs::remove_dir_all(&target);
                } else {
                    let _ = std::fs::remove_file(&target);
                }
            }
        }
        let listed = self.git(&["ls-files", "-z", "-m", "-d"]).await?;
        let mut drifted: Vec<&str> = listed.split('\0').filter(|p| !p.is_empty()).collect();
        drifted.sort();
        drifted.dedup();
        for path in &drifted {
            self.clear_way(path);
        }
        if !drifted.is_empty() {
            let mut args = vec!["checkout-index", "-f", "-u", "-q", "--"];
            args.extend(drifted.iter().copied());
            self.git(&args).await?;
        }
        for dir in &overlay.created {
            let _ = std::fs::remove_dir(self.work_tree.join(dir));
        }
        let _ = std::fs::remove_file(self.dirty_file());
        Ok(())
    }

    /// Takes off an overlay a crash left on the tree.
    pub async fn recover(&self) -> Result<(), String> {
        self.guard()?;
        let Ok(text) = std::fs::read(self.dirty_file()) else {
            return Ok(());
        };
        match serde_json::from_slice::<Overlay>(&text) {
            Ok(overlay) => self.restore(&overlay).await,
            Err(_) => {
                let _ = std::fs::remove_file(self.dirty_file());
                Ok(())
            }
        }
    }
}
