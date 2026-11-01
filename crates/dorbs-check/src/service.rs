//! The service's two requests: resolve the repo's recipe at the commit, find or set up its
//! environment, and run the checks or tests there with the change laid over the tree.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use sha2::{Digest, Sha256};

use crate::adapter::{Adapter, Glob, Phase, Scope};
use crate::config::{Settings, Token};
use crate::docker::{Docker, REPO_ROOT};
use crate::environments::{EnvSpec, Environments, UseError};
use crate::format::Streams;
use crate::git::{self, Caches, FetchError};
use crate::protocol::{
    Change, CheckRequest, CheckResponse, CommitSha, File, RejectReason, RelativePath, RepoId,
    TestRequest, TestResponse,
};
use crate::recipe;
use crate::run::{self, Timings};
use crate::view::{View, setup_change};

/// Why the service could not answer: the fetch failed (502), the image is missing (503), or a fault
/// of its own (500).
#[derive(Debug)]
pub enum Failure {
    Fetch(String),
    ImageMissing(String),
    Internal(String),
    /// Nobody wanted the answer any more before the run began.
    Abandoned,
}

/// A commit's paths and the contents of the files the adapters read, which never change.
type Files = Arc<(Vec<RelativePath>, HashMap<String, String>)>;

/// How many commits' files the service keeps; sessions start from few commits.
const KEPT_COMMITS: usize = 16;

pub struct Service {
    pub settings: Settings,
    caches: Caches,
    docker: Arc<Docker>,
    pub environments: Arc<Environments>,
    /// Numbers requests as they arrive, so they take the environment in that order.
    tickets: AtomicU64,
    files: Mutex<HashMap<(PathBuf, CommitSha), Files>>,
}

struct Prepared {
    spec: Arc<EnvSpec>,
    streams: Streams,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256(text: &[u8]) -> String {
    hex(&Sha256::digest(text))
}

/// The paths `globs` match, as the adapter sees them.
fn matching<'a>(
    adapter: &Adapter,
    paths: &'a [RelativePath],
    globs: &[String],
) -> Vec<&'a RelativePath> {
    let globs: Vec<Glob> = globs
        .iter()
        .filter_map(|glob| Glob::new(glob).ok())
        .collect();
    let ignore = &adapter.ignore;
    (paths.iter())
        .filter(|path| {
            !ignore.iter().any(|g| g.is_match(path)) && globs.iter().any(|g| g.is_match(path))
        })
        .collect()
}

impl Service {
    pub fn new(
        settings: Settings,
        docker: Arc<Docker>,
        environments: Arc<Environments>,
    ) -> Service {
        Service {
            caches: Caches::new(&settings.data_dir),
            settings,
            docker,
            environments,
            tickets: AtomicU64::new(0),
            files: Mutex::new(HashMap::new()),
        }
    }

    /// The commit's paths and read files, listed once per commit.
    async fn files(&self, git_dir: &Path, commit: &CommitSha) -> Result<Files, Failure> {
        let key = (git_dir.to_owned(), commit.clone());
        if let Some(files) = self.files.lock().expect("the files").get(&key) {
            return Ok(files.clone());
        }
        let listed = git::files(git_dir, commit, &self.settings.adapters.reads)
            .await
            .map_err(Failure::Internal)?;
        let files: Files = Arc::new(listed);
        let mut kept = self.files.lock().expect("the files");
        if kept.len() >= KEPT_COMMITS {
            kept.clear();
        }
        kept.insert(key, files.clone());
        Ok(files)
    }

    /// The recipe and environment a request runs in, or why it cannot run.
    async fn prepare(
        &self,
        repo_id: &RepoId,
        commit: &CommitSha,
        change: &Change,
    ) -> Result<Result<Prepared, RejectReason>, Failure> {
        let Some(repo) = self.settings.repos.get(repo_id) else {
            return Ok(Err(RejectReason::UnknownRepo {}));
        };
        let token = match &repo.token {
            Token::None => None,
            Token::Env(name) => std::env::var(name).ok(),
            Token::App { owner, name } => {
                let app = self
                    .settings
                    .app
                    .as_ref()
                    .expect("an App when a repo uses it");
                Some(app.token(owner, name).await.map_err(Failure::Fetch)?)
            }
        };
        let git_dir = match self
            .caches
            .fetch(repo_id, &repo.url, commit, token.as_deref())
            .await
        {
            Ok(dir) => dir,
            Err(FetchError::UnknownCommit) => return Ok(Err(RejectReason::UnknownCommit {})),
            Err(FetchError::Failed(output)) => {
                return Err(Failure::Fetch(format!(
                    "git fetch from {repo_id} failed:\n{output}"
                )));
            }
        };
        let adapters = &self.settings.adapters;
        let files = self.files(&git_dir, commit).await?;
        let (paths, inputs) = (&files.0, &files.1);
        let view = View::new(paths.clone(), inputs.clone(), change, &adapters.commit_only);
        let recipe = match recipe::resolve(adapters, &view, repo.recipe.as_deref(), false) {
            Ok(recipe) => recipe,
            Err(reason) => return Ok(Err(RejectReason::NoRecipe { reason })),
        };
        let adapter = adapters.get(&recipe.adapter).expect("the recipe's adapter");
        let image = self
            .docker
            .image_id(&adapter.name, &adapter.image)
            .await
            .map_err(|e| Failure::ImageMissing(e.0))?;
        let all_keys: Vec<String> = recipe
            .setup
            .iter()
            .flat_map(|step| step.key.clone())
            .collect();
        let key_files: Vec<&RelativePath> = matching(adapter, view.paths(), &all_keys);
        let key_hashes: Vec<(String, String)> = (key_files.iter())
            .map(|path| {
                (
                    path.to_string(),
                    sha256(view.read(path).unwrap_or("\0absent").as_bytes()),
                )
            })
            .collect();
        let key = sha256(
            serde_json::json!({ "repo": repo_id, "image": image, "recipe": recipe, "keyFiles": key_hashes }).to_string().as_bytes(),
        );
        let key_set: HashSet<String> = key_files.iter().map(|path| path.to_string()).collect();
        let key_change = setup_change(change, &key_set, &adapters.commit_only);
        let online = |field: fn(&recipe::SetupStep) -> &Vec<String>| -> Vec<String> {
            let steps = recipe
                .setup
                .iter()
                .filter(|step| step.phase == Phase::Online);
            steps.flat_map(field).cloned().collect()
        };
        let online_keys = online(|step| &step.key);
        let online_set: HashSet<String> = matching(adapter, view.paths(), &online_keys)
            .iter()
            .map(|p| p.to_string())
            .collect();
        let online_paths: Vec<RelativePath> = paths
            .iter()
            .filter(|path| online_set.contains(path.as_str()))
            .cloned()
            .collect();
        let mut online_change = Change {
            files: key_change
                .files
                .iter()
                .filter(|file| online_set.contains(file.path.as_str()))
                .cloned()
                .collect(),
            deleted: key_change
                .deleted
                .iter()
                .filter(|path| online_set.contains(path.as_str()))
                .cloned()
                .collect(),
        };
        // An online step that needs a file to exist, such as cargo a crate's sources, gets it empty.
        let stubs = matching(adapter, view.paths(), &online(|step| &step.stubs));
        online_change
            .files
            .extend(stubs.into_iter().map(|path| File {
                path: path.clone(),
                content: String::new(),
            }));
        let streams = Scope::new(adapter, &view)
            .map_err(Failure::Internal)?
            .streams();
        let spec = EnvSpec {
            key,
            repo: repo_id.clone(),
            git_dir,
            recipe,
            image,
            key_change,
            online_paths,
            online_change,
        };
        Ok(Ok(Prepared {
            spec: Arc::new(spec),
            streams,
        }))
    }

    pub async fn check(
        &self,
        request: CheckRequest,
        wanted: impl Fn() -> bool,
    ) -> Result<CheckResponse, Failure> {
        let started = Instant::now();
        let ticket = self.tickets.fetch_add(1, Ordering::Relaxed);
        let prepared = match self
            .prepare(&request.repo, &request.commit, &request.change)
            .await?
        {
            Ok(prepared) => prepared,
            Err(reason) => return Ok(CheckResponse::Rejected { reason }),
        };
        let checks = match run::select(&prepared.spec.recipe, request.only.as_deref()) {
            Ok(checks) => checks,
            Err(reason) => return Ok(CheckResponse::Rejected { reason }),
        };
        let planned: Vec<Option<run::Command>> = checks
            .iter()
            .map(|check| run::check_command(check, &request.change))
            .collect();
        let commands = planned
            .iter()
            .flatten()
            .map(|command| (command.clone(), self.settings.check_timeout))
            .collect();
        let spec = prepared.spec.clone();
        let used = match self
            .environments
            .run(
                spec.clone(),
                ticket,
                request.commit.clone(),
                request.change.clone(),
                commands,
                wanted,
            )
            .await
        {
            Ok(used) => used,
            Err(UseError::SetupFailed(failed)) => return Ok(CheckResponse::SetupFailed(failed)),
            Err(UseError::UnsafePath(paths)) => {
                return Ok(CheckResponse::Rejected {
                    reason: RejectReason::UnsafePath { paths },
                });
            }
            Err(UseError::Internal(error)) => return Err(Failure::Internal(error)),
            Err(UseError::Abandoned) => {
                crate::log(&format!(
                    "dropped a check on {}@{} nobody waits for after {} ms",
                    request.repo,
                    &request.commit[..12],
                    started.elapsed().as_millis()
                ));
                return Err(Failure::Abandoned);
            }
        };
        let mut ran = used.value.into_iter();
        let runs = (checks.iter().zip(&planned))
            .map(|(check, command)| match command {
                None => run::skipped(check),
                Some(_) => run::check_run(
                    check,
                    &ran.next().expect("a run per command"),
                    REPO_ROOT,
                    &prepared.streams,
                ),
            })
            .collect::<Vec<_>>();
        let timings = Timings {
            env_key: spec.key.clone(),
            started,
            setup_ms: used.setup_ms,
            overlay_ms: used.overlay_ms,
            queue_ms: Some(used.queue_ms),
        };
        let result = run::check_result(&checks, runs, timings);
        let summary: Vec<String> = result
            .checks
            .iter()
            .map(|run| {
                format!(
                    "{}={:?}/{} {} ms",
                    run.id,
                    run.status,
                    run.diagnostics.len(),
                    run.duration_ms
                )
            })
            .collect();
        crate::log(&format!(
            "check {}@{} env {} replica {}: {} in {} ms (queue {}, setup {}, overlay {})",
            request.repo,
            &request.commit[..12],
            &spec.key[..12],
            used.replica,
            summary.join(" "),
            result.duration_ms,
            used.queue_ms,
            result.setup_ms,
            result.overlay_ms
        ));
        Ok(CheckResponse::CheckResult(result))
    }

    pub async fn test(
        &self,
        request: TestRequest,
        wanted: impl Fn() -> bool,
    ) -> Result<TestResponse, Failure> {
        let started = Instant::now();
        let ticket = self.tickets.fetch_add(1, Ordering::Relaxed);
        let prepared = match self
            .prepare(&request.repo, &request.commit, &request.change)
            .await?
        {
            Ok(prepared) => prepared,
            Err(reason) => return Ok(TestResponse::Rejected { reason }),
        };
        let no_test = |reason: String| TestResponse::Rejected {
            reason: RejectReason::NoTestCommand { reason },
        };
        let Some(test) = prepared.spec.recipe.test.clone() else {
            return Ok(no_test(
                "The service found no test command for this repo.".to_owned(),
            ));
        };
        let files: Vec<String> = request
            .files
            .iter()
            .flatten()
            .map(|file| file.to_string())
            .collect();
        let commands = match run::test_commands(&test, &files, request.filter.as_deref()) {
            Ok(commands) => commands,
            Err(reason) => return Ok(no_test(reason)),
        };
        let commands = commands
            .into_iter()
            .map(|command| (command, self.settings.test_timeout))
            .collect();
        let spec = prepared.spec.clone();
        let used = match self
            .environments
            .run(
                spec.clone(),
                ticket,
                request.commit.clone(),
                request.change.clone(),
                commands,
                wanted,
            )
            .await
        {
            Ok(used) => used,
            Err(UseError::SetupFailed(failed)) => return Ok(TestResponse::SetupFailed(failed)),
            Err(UseError::UnsafePath(paths)) => {
                return Ok(TestResponse::Rejected {
                    reason: RejectReason::UnsafePath { paths },
                });
            }
            Err(UseError::Internal(error)) => return Err(Failure::Internal(error)),
            Err(UseError::Abandoned) => {
                crate::log(&format!(
                    "dropped a test on {}@{} nobody waits for after {} ms",
                    request.repo,
                    &request.commit[..12],
                    started.elapsed().as_millis()
                ));
                return Err(Failure::Abandoned);
            }
        };
        let timings = Timings {
            env_key: spec.key.clone(),
            started,
            setup_ms: used.setup_ms,
            overlay_ms: used.overlay_ms,
            queue_ms: Some(used.queue_ms),
        };
        let result = run::test_result(&test, &used.value, timings);
        let count = |n: Option<u64>| n.map_or("?".to_owned(), |n| n.to_string());
        let run_ms: u128 = used.value.iter().map(|ran| ran.duration.as_millis()).sum();
        crate::log(&format!(
            "test {}@{} env {} replica {}: exit {:?}, {} passed, {} failed, run {} ms in {} ms (queue {}, setup {}, overlay {})",
            request.repo,
            &request.commit[..12],
            &spec.key[..12],
            used.replica,
            result.exit_code,
            count(result.passed),
            count(result.failed),
            run_ms,
            result.duration_ms,
            used.queue_ms,
            result.setup_ms,
            result.overlay_ms
        ));
        Ok(TestResponse::TestResult(result))
    }
}
