//! check and test against a checkout on this machine: the same recipe and formats as the service,
//! with the commands run here, in the checkout, with whatever its owner installed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::adapter::{Adapters, Scope};
use crate::process::{self, Env, Spec};
use crate::protocol::{Change, CheckId, CheckResult, File, RelativePath, TestResult};
use crate::recipe::{self, Recipe};
use crate::run::{self, Command, KEEP_BYTES, Ran, Runner, Timings};
use crate::view::View;

pub const CHECK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub const TEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// A checkout and the recipe it resolves to.
pub struct Checkout {
    pub dir: PathBuf,
    root: String,
    pub view: View,
    pub recipe: Recipe,
    pub adapters: Adapters,
    /// The files that differ from HEAD, for checks that look at changed files.
    pub change: Change,
    reports: PathBuf,
    counter: AtomicU64,
}

impl Checkout {
    pub fn open(dir: &Path, adapters: Adapters) -> Result<Checkout, String> {
        let dir = dir
            .canonicalize()
            .map_err(|e| format!("{}: {e}", dir.display()))?;
        let root = dir.to_string_lossy().into_owned();
        let paths = list(&dir)?;
        let files: HashMap<String, String> = (paths.iter())
            .filter(|path| adapters.reads.is_match(path.as_str()))
            .filter_map(|path| {
                Some((
                    path.to_string(),
                    std::fs::read_to_string(dir.join(path.as_str())).ok()?,
                ))
            })
            .collect();
        let view = View::new(paths, files, &Change::default(), &adapters.commit_only);
        let recipe = recipe::resolve(&adapters, &view, None, true)?;
        let change = changed(&dir);
        let reports = reports_dir()?;
        Ok(Checkout {
            dir,
            root,
            view,
            recipe,
            adapters,
            change,
            reports,
            counter: AtomicU64::new(0),
        })
    }

    fn timings(&self, started: Instant) -> Timings {
        Timings {
            env_key: "local".to_owned(),
            started,
            setup_ms: 0,
            overlay_ms: 0,
        }
    }

    fn scope(&self) -> Scope<'_> {
        let adapter = self
            .adapters
            .get(&self.recipe.adapter)
            .expect("the recipe's adapter");
        Scope::new(adapter, &self.view).expect("a scope the recipe resolved with")
    }

    pub async fn check(&self, only: Option<&[CheckId]>) -> Result<CheckResult, String> {
        let started = Instant::now();
        let checks = run::select(&self.recipe, only).map_err(|reason| format!("{reason:?}"))?;
        let streams = self.scope().streams();
        let mut runs = Vec::new();
        for check in &checks {
            runs.push(match run::check_command(check, &self.change) {
                None => run::skipped(check),
                Some(command) => run::check_run(
                    check,
                    &self.exec(&command, CHECK_TIMEOUT).await,
                    &self.root,
                    &streams,
                ),
            });
        }
        Ok(run::check_result(&checks, runs, self.timings(started)))
    }

    pub async fn test(&self, files: &[String], filter: Option<&str>) -> Result<TestResult, String> {
        let started = Instant::now();
        let test = self
            .recipe
            .test
            .as_ref()
            .ok_or("No test command for this repo.")?;
        let mut runs = Vec::new();
        for command in run::test_commands(test, files, filter)? {
            runs.push(self.exec(&command, TEST_TIMEOUT).await);
        }
        Ok(run::test_result(test, &runs, self.timings(started)))
    }
}

impl Drop for Checkout {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.reports);
    }
}

impl Runner for Checkout {
    fn root(&self) -> &str {
        &self.root
    }

    async fn exec(&self, command: &Command, timeout: Duration) -> Ran {
        let started = Instant::now();
        let report = command.run.contains("{report}").then(|| {
            let _ = std::fs::create_dir_all(&self.reports);
            self.reports
                .join(self.counter.fetch_add(1, Ordering::Relaxed).to_string())
        });
        let run = match &report {
            Some(path) => command
                .run
                .replace("{report}", &run::quote(&path.to_string_lossy())),
            None => command.run.clone(),
        };
        let cwd = if command.cwd == "." {
            self.dir.clone()
        } else {
            self.dir.join(&command.cwd)
        };
        let spec = Spec {
            program: "sh",
            args: &["-c", &run],
            cwd: &cwd,
            env: Env::Inherit,
            timeout,
            keep: KEEP_BYTES,
            stdin: None,
        };
        let result = process::run(spec)
            .await
            .unwrap_or_else(|error| process::ProcessResult {
                stdout: String::new(),
                stderr: format!("sh did not start: {error}"),
                exit_code: None,
                timed_out: false,
                truncated: false,
            });
        let report = report.and_then(|path| {
            let text = std::fs::read_to_string(&path).ok();
            let _ = std::fs::remove_file(&path);
            text
        });
        Ran {
            run,
            result,
            report,
            duration: started.elapsed(),
        }
    }
}

/// A new directory only this user can enter, for the reports runs write.
fn reports_dir() -> Result<PathBuf, String> {
    use std::os::unix::fs::DirBuilderExt;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("dorbs-check-{}-{nanos}", std::process::id()));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// The checkout's files: git's tracked and untracked ones that it does not ignore, or every file.
fn list(dir: &Path) -> Result<Vec<RelativePath>, String> {
    let git = std::process::Command::new("git")
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .current_dir(dir)
        .output();
    let names: Vec<String> = match git {
        Ok(output) if output.status.success() => (String::from_utf8_lossy(&output.stdout)
            .split('\0'))
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect(),
        _ => walk(dir, dir),
    };
    let mut paths: Vec<RelativePath> = names
        .into_iter()
        .filter_map(|name| RelativePath::try_from(name).ok())
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn walk(root: &Path, dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() && ![".git", "node_modules", "target", ".venv"].contains(&name.as_str()) {
            found.extend(walk(root, &path));
        } else if kind.is_file() {
            found.extend(
                path.strip_prefix(root)
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned()),
            );
        }
    }
    found
}

/// The files that differ from HEAD, new ones included, as a change.
fn changed(dir: &Path) -> Change {
    let output = std::process::Command::new("git")
        .args(["status", "--porcelain", "-z", "--untracked-files=all"])
        .current_dir(dir)
        .output();
    let Ok(output) = output else {
        return Change::default();
    };
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut change = Change::default();
    for entry in text.split('\0').filter(|entry| entry.len() > 3) {
        let (status, path) = entry.split_at(3);
        let Ok(path) = RelativePath::try_from(path) else {
            continue;
        };
        if status.contains('D') {
            change.deleted.push(path);
        } else if let Ok(content) = std::fs::read_to_string(dir.join(path.as_str())) {
            change.files.push(File { path, content });
        }
    }
    change
}
