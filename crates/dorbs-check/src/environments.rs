//! The environments: each one repo at one recipe, key-file content and image, set up once and
//! shared by every request on the repo, one run at a time, with a disk budget over them all.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, Semaphore, watch};

use crate::docker::{Docker, REPO_ROOT, tail};
use crate::env::{EnvEvent, EnvState, Millis, Phase};
use crate::git::{Overlaid, Tree};
use crate::process::ProcessResult;
use crate::protocol::{Change, CommitSha, RelativePath, RepoId, SetupFailed};
use crate::recipe::{Recipe, SetupStep};
use crate::run::{Command, Ran, Runner};

/// What makes an environment: its key, and what setting it up needs.
pub struct EnvSpec {
    pub key: String,
    pub repo: RepoId,
    /// The repo's bare cache, which holds the commit.
    pub git_dir: PathBuf,
    pub recipe: Recipe,
    /// The image id.
    pub image: String,
    /// The change's key files, laid over the commit while setup runs, as the key includes them.
    pub key_change: Change,
    /// What the online steps see: the commit's files at these paths, and this change over them.
    pub online_paths: Vec<RelativePath>,
    pub online_change: Change,
}

pub struct Used<T> {
    pub value: T,
    pub setup_ms: u64,
    pub overlay_ms: u64,
}

pub enum UseError {
    SetupFailed(SetupFailed),
    /// Paths the change writes through a symbolic link of the tree.
    UnsafePath(Vec<RelativePath>),
    Internal(String),
}

#[derive(Serialize)]
pub struct Summary {
    pub key: String,
    pub repo: RepoId,
    pub state: Phase,
    pub bytes: u64,
}

struct Env {
    key: String,
    repo: RepoId,
    dir: PathBuf,
    container: String,
    /// One run at a time; tokio's mutex queues them in order.
    queue: tokio::sync::Mutex<()>,
    inner: Mutex<Inner>,
    /// Signals the run holding the tree that a request that joined it is done.
    left: Notify,
}

/// The run holding the tree, which a request for the same commit and change joins instead of queueing
/// behind it, as a check and a test of one workspace state do: the tree they need is already laid.
struct Shared {
    commit: CommitSha,
    change: Change,
    joined: usize,
    /// Whether the holder's own commands still run; once they end, no request joins, so joins cannot
    /// keep the tree held.
    open: bool,
}

/// The most requests one run takes beside it, so joins stay within a few runs of the slot it holds.
const MAX_JOINED: usize = 2;

struct Inner {
    state: EnvState,
    /// Settles when the setup in flight does, so concurrent requests wait for one setup.
    setting_up: Option<watch::Receiver<bool>>,
    bytes: u64,
    measured_at: Millis,
    /// The pid of the running container's keeper process.
    keeper: Option<String>,
    shared: Option<Shared>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    key: String,
    repo: RepoId,
    tree: CommitSha,
    last_used: Millis,
    bytes: u64,
}

pub struct Limits {
    pub disk_budget: u64,
    pub idle_after: Duration,
    pub retry_setup_after: Duration,
    pub setup_timeout: Duration,
}

pub struct Environments {
    docker: Arc<Docker>,
    limits: Limits,
    envs: Mutex<HashMap<String, Arc<Env>>>,
    slots: Semaphore,
    setups: Semaphore,
    evict_turn: tokio::sync::Mutex<()>,
    envs_dir: PathBuf,
    meta_dir: PathBuf,
    trash_dir: PathBuf,
}

pub fn now() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as Millis
}

/// A failed step's output, its end kept, which is where the error is.
fn failure_tail(result: &ProcessResult) -> String {
    let text = format!("{}\n{}", result.stdout, result.stderr);
    let lines: Vec<&str> = text.trim().lines().collect();
    tail(&lines[lines.len().saturating_sub(60)..].join("\n"), 8000).to_owned()
}

/// Commands in an environment's container; `{report}` is a file in its /tmp, read back from inside.
struct InContainer<'a> {
    docker: &'a Docker,
    container: &'a str,
}

impl Runner for InContainer<'_> {
    fn root(&self) -> &str {
        REPO_ROOT
    }

    async fn exec(&self, command: &Command, timeout: Duration) -> Ran {
        let started = Instant::now();
        let report = command
            .run
            .contains("{report}")
            .then(|| format!("/tmp/dorbs-report-{}", crate::random_id()));
        let run = report.as_ref().map_or_else(
            || command.run.clone(),
            |path| command.run.replace("{report}", path),
        );
        let result = self
            .docker
            .exec(self.container, &command.cwd, &run, timeout)
            .await;
        // Read inside the container, so a link the run left there resolves to nothing of the host's.
        let report = match &report {
            Some(path) => {
                let read = format!("cat {path} 2>/dev/null; rm -f {path}");
                let kept = self
                    .docker
                    .exec(self.container, ".", &read, Duration::from_secs(60))
                    .await;
                (kept.exit_code == Some(0) && !kept.stdout.is_empty()).then_some(kept.stdout)
            }
            None => None,
        };
        Ran {
            run,
            result,
            report,
            duration: started.elapsed(),
        }
    }
}

impl Environments {
    /// The environments a previous run left, back as idle; directories without one go, and so does
    /// every container the service made, which may carry older limits.
    pub async fn start(
        data_dir: &Path,
        docker: Arc<Docker>,
        limits: Limits,
        run_slots: usize,
    ) -> Result<Arc<Self>, String> {
        let (envs_dir, meta_dir, trash_dir) = (
            data_dir.join("envs"),
            data_dir.join("meta"),
            data_dir.join("trash"),
        );
        for dir in [&envs_dir, &meta_dir, &trash_dir] {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let environments = Arc::new(Environments {
            docker,
            limits,
            envs: Mutex::new(HashMap::new()),
            slots: Semaphore::new(run_slots),
            setups: Semaphore::new(2),
            evict_turn: tokio::sync::Mutex::new(()),
            envs_dir,
            meta_dir,
            trash_dir,
        });
        for entry in std::fs::read_dir(&environments.meta_dir)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let Some(meta) = std::fs::read(&path)
                .ok()
                .and_then(|text| serde_json::from_slice::<Meta>(&text).ok())
            else {
                continue;
            };
            let env = environments.new_env(&meta.key, &meta.repo);
            {
                let mut inner = env.inner.lock().expect("the env");
                inner.state = EnvState::Idle {
                    tree: meta.tree,
                    last_used: meta.last_used,
                };
                inner.bytes = meta.bytes;
            }
            environments
                .envs
                .lock()
                .expect("the envs")
                .insert(meta.key.clone(), env);
        }
        for container in environments.docker.list().await? {
            environments.docker.remove(&container.name).await;
        }
        for entry in std::fs::read_dir(&environments.envs_dir)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !environments
                .envs
                .lock()
                .expect("the envs")
                .contains_key(&name)
            {
                environments.discard(&entry.path());
            }
        }
        for entry in std::fs::read_dir(&environments.trash_dir)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            tokio::task::spawn_blocking(move || std::fs::remove_dir_all(entry.path()));
        }
        let idle = environments.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                idle.stop_idle().await;
            }
        });
        Ok(environments)
    }

    fn new_env(&self, key: &str, repo: &RepoId) -> Arc<Env> {
        Arc::new(Env {
            key: key.to_owned(),
            repo: repo.clone(),
            dir: self.envs_dir.join(key),
            container: self.docker.container_name(key),
            queue: tokio::sync::Mutex::new(()),
            inner: Mutex::new(Inner {
                state: EnvState::Absent,
                setting_up: None,
                bytes: 0,
                measured_at: 0,
                keeper: None,
                shared: None,
            }),
            left: Notify::new(),
        })
    }

    fn env_for(&self, spec: &EnvSpec) -> Arc<Env> {
        let mut envs = self.envs.lock().expect("the envs");
        envs.entry(spec.key.clone())
            .or_insert_with(|| self.new_env(&spec.key, &spec.repo))
            .clone()
    }

    fn tree(&self, env: &Env, git_dir: &Path) -> Tree {
        Tree {
            git_dir: git_dir.to_owned(),
            work_tree: env.dir.join("repo"),
            index_file: self.meta_dir.join(format!("{}.index", env.key)),
        }
    }

    fn take(env: &Env, event: EnvEvent) {
        env.inner.lock().expect("the env").state.take(event);
    }

    fn state(env: &Env) -> EnvState {
        env.inner.lock().expect("the env").state.clone()
    }

    fn save_meta(&self, env: &Env) {
        let inner = env.inner.lock().expect("the env");
        let (EnvState::Ready { tree, last_used } | EnvState::Idle { tree, last_used }) =
            &inner.state
        else {
            return;
        };
        let meta = Meta {
            key: env.key.clone(),
            repo: env.repo.clone(),
            tree: tree.clone(),
            last_used: *last_used,
            bytes: inner.bytes,
        };
        let _ = std::fs::write(
            self.meta_dir.join(format!("{}.json", env.key)),
            serde_json::to_vec(&meta).expect("meta serializes"),
        );
    }

    /// Moves a directory out of the way at once and deletes it in the background.
    fn discard(&self, dir: &Path) {
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let trash = self
            .trash_dir
            .join(format!("{name}-{}", crate::random_id()));
        if std::fs::rename(dir, &trash).is_ok() {
            tokio::task::spawn_blocking(move || std::fs::remove_dir_all(trash));
        }
    }

    async fn measure(&self, env: &Env) {
        let dir = env.dir.to_string_lossy().into_owned();
        let spec = crate::process::Spec {
            program: "du",
            args: &["-sk", &dir],
            cwd: &self.envs_dir,
            env: crate::process::Env::Clean(&[]),
            timeout: Duration::from_secs(300),
            keep: 1 << 16,
            stdin: None,
        };
        if let Ok(result) = crate::process::run(spec).await {
            let kib = result
                .stdout
                .split_whitespace()
                .next()
                .and_then(|n| n.parse::<u64>().ok());
            let mut inner = env.inner.lock().expect("the env");
            if let Some(kib) = kib {
                inner.bytes = kib * 1024;
            }
            inner.measured_at = now();
        }
        self.save_meta(env);
    }

    async fn evict(&self, env: &Env) {
        let _queue = env.queue.lock().await;
        if !matches!(
            Self::state(env).phase(),
            Phase::Ready | Phase::Idle | Phase::Failed
        ) {
            return;
        }
        self.docker.remove(&env.container).await;
        let _ = std::fs::remove_file(self.meta_dir.join(format!("{}.json", env.key)));
        let _ = std::fs::remove_file(self.meta_dir.join(format!("{}.index", env.key)));
        self.discard(&env.dir);
        {
            let mut inner = env.inner.lock().expect("the env");
            inner.bytes = 0;
            inner.keeper = None;
            inner.state.take(EnvEvent::Evicted);
        }
        crate::log(&format!("evicted environment {} of {}", env.key, env.repo));
    }

    /// Evicts the least recently used environments, other than `keep`, until the rest fit in `limit`.
    async fn fit(&self, limit: u64, keep: &str) {
        let _turn = self.evict_turn.lock().await;
        let all: Vec<Arc<Env>> = self
            .envs
            .lock()
            .expect("the envs")
            .values()
            .cloned()
            .collect();
        let mut total: u64 = all
            .iter()
            .map(|env| env.inner.lock().expect("the env").bytes)
            .sum();
        let mut candidates: Vec<(Millis, Arc<Env>)> = (all.into_iter())
            .filter(|env| env.key != keep)
            .filter_map(|env| {
                let state = Self::state(&env);
                matches!(state.phase(), Phase::Ready | Phase::Idle | Phase::Failed)
                    .then(|| (state.last_used(), env))
            })
            .collect();
        candidates.sort_by_key(|(used, _)| *used);
        for (_, env) in candidates {
            if total <= limit {
                break;
            }
            total = total.saturating_sub(env.inner.lock().expect("the env").bytes);
            self.evict(&env).await;
        }
    }

    /// Stops the containers of environments idle past IDLE_AFTER; their trees and installs stay.
    async fn stop_idle(&self) {
        let cutoff = now().saturating_sub(self.limits.idle_after.as_millis() as Millis);
        let all: Vec<Arc<Env>> = self
            .envs
            .lock()
            .expect("the envs")
            .values()
            .cloned()
            .collect();
        for env in all {
            if !matches!(Self::state(&env), EnvState::Ready { last_used, .. } if last_used <= cutoff)
            {
                continue;
            }
            let _queue = env.queue.lock().await;
            if Self::state(&env).phase() != Phase::Ready {
                continue;
            }
            self.docker.stop(&env.container).await;
            {
                let mut inner = env.inner.lock().expect("the env");
                inner.keeper = None;
                inner.state.take(EnvEvent::Stopped);
            }
            self.save_meta(&env);
        }
    }

    /// Runs `steps` until one fails, and answers that one's failure.
    async fn run_steps(
        &self,
        spec: &EnvSpec,
        env: &Env,
        steps: &[&SetupStep],
    ) -> Option<(String, String)> {
        for step in steps {
            let network = step.phase != crate::adapter::Phase::Offline;
            let result = (self.docker)
                .setup(
                    &spec.image,
                    &spec.recipe.env,
                    &env.dir,
                    &step.cwd,
                    &step.run,
                    network,
                    self.limits.setup_timeout,
                )
                .await;
            if result.exit_code != Some(0) {
                let reason = if result.timed_out {
                    format!(
                        "timed out after {} s\n",
                        self.limits.setup_timeout.as_secs()
                    )
                } else {
                    String::new()
                };
                return Some((
                    step.id.clone(),
                    format!("{reason}{}", failure_tail(&result)),
                ));
            }
        }
        None
    }

    /// Sets the environment up: the online steps in a tree of their key files alone, which goes
    /// before the source comes; then the rest on the commit with the change's key files over it.
    async fn set_up(
        &self,
        env: &Env,
        spec: &EnvSpec,
        commit: &CommitSha,
    ) -> Result<Option<(String, String)>, String> {
        let _permit = self.setups.acquire().await.map_err(|e| e.to_string())?;
        self.discard(&env.dir);
        std::fs::create_dir_all(env.dir.join("home")).map_err(|e| e.to_string())?;
        let tree = self.tree(env, &spec.git_dir);
        let phase = |p: crate::adapter::Phase| -> Vec<&SetupStep> {
            spec.recipe.setup.iter().filter(|s| s.phase == p).collect()
        };
        let online = phase(crate::adapter::Phase::Online);
        if !online.is_empty() {
            tree.materialize(commit, Some(&spec.online_paths)).await?;
            tree.overlay(&spec.online_change)
                .map_err(|paths| format!("unsafe paths in the online tree: {paths:?}"))?;
            if let Some(failed) = self.run_steps(spec, env, &online).await {
                return Ok(Some(failed));
            }
            self.discard(&tree.work_tree);
        }
        tree.materialize(commit, None).await?;
        let overlay = tree
            .overlay(&spec.key_change)
            .map_err(|paths| format!("unsafe key files: {paths:?}"))?;
        let mut rest = phase(crate::adapter::Phase::OnlineWithSource);
        rest.extend(phase(crate::adapter::Phase::Offline));
        let failed = self.run_steps(spec, env, &rest).await;
        tree.restore(&overlay).await?;
        if failed.is_some() {
            return Ok(failed);
        }
        let keeper = self
            .docker
            .create(
                &env.container,
                &env.key,
                &spec.image,
                &spec.recipe.env,
                &env.dir,
            )
            .await?;
        env.inner.lock().expect("the env").keeper = Some(keeper);
        Ok(None)
    }

    async fn setup(
        self: Arc<Self>,
        env: Arc<Env>,
        spec: Arc<EnvSpec>,
        commit: CommitSha,
        done: watch::Sender<bool>,
    ) {
        let started = Instant::now();
        crate::log(&format!(
            "setting up {} for {} at {commit}",
            env.key, spec.repo
        ));
        // Room for the new environment, which may be as big as a quarter of the budget.
        self.fit(self.limits.disk_budget / 4 * 3, &env.key).await;
        // A failure of the service's own, such as a failed checkout, fails the setup like a step.
        let failure = self
            .set_up(&env, &spec, &commit)
            .await
            .unwrap_or_else(|error| Some(("service".to_owned(), error)));
        match failure {
            Some((step, output)) => {
                Self::take(
                    &env,
                    EnvEvent::SetupFailed {
                        step: step.clone(),
                        output,
                        at: now(),
                    },
                );
                self.discard(&env.dir);
                crate::log(&format!("setup of {} failed at {step}", env.key));
            }
            None => {
                Self::take(
                    &env,
                    EnvEvent::SetupSucceeded {
                        tree: commit,
                        at: now(),
                    },
                );
                self.measure(&env).await;
                let bytes = env.inner.lock().expect("the env").bytes;
                crate::log(&format!(
                    "set up {} in {} ms, {bytes} bytes",
                    env.key,
                    started.elapsed().as_millis()
                ));
                let this = self.clone();
                let key = env.key.clone();
                tokio::spawn(async move { this.fit(this.limits.disk_budget, &key).await });
            }
        }
        env.inner.lock().expect("the env").setting_up = None;
        let _ = done.send(true);
    }

    /// Brings the environment to Ready, Busy or Idle, or answers why it cannot be.
    async fn ready(
        self: &Arc<Self>,
        env: &Arc<Env>,
        spec: &Arc<EnvSpec>,
        commit: &CommitSha,
    ) -> Result<u64, SetupFailed> {
        let started = Instant::now();
        let failed = |step: &str, output: &str| SetupFailed {
            env_key: env.key.clone(),
            step: step.to_owned(),
            output: output.to_owned(),
        };
        loop {
            let (mut waiting, own) = {
                let mut inner = env.inner.lock().expect("the env");
                match &inner.state {
                    EnvState::Ready { .. } | EnvState::Busy { .. } | EnvState::Idle { .. } => {
                        return Ok(started.elapsed().as_millis() as u64);
                    }
                    EnvState::SettingUp if inner.setting_up.is_some() => {
                        (inner.setting_up.clone().expect("a setup"), false)
                    }
                    EnvState::Failed { step, output, at }
                        if now() < at + self.limits.retry_setup_after.as_millis() as Millis
                            || inner.setting_up.is_some() =>
                    {
                        return Err(failed(step, output));
                    }
                    _ => {
                        // One step, so no other request can start a second setup in between.
                        inner.state.take(EnvEvent::SetupStarted);
                        let (done, waiting) = watch::channel(false);
                        inner.setting_up = Some(waiting.clone());
                        // Setup runs on its own, so a client hanging up does not leave it half done.
                        tokio::spawn(self.clone().setup(
                            env.clone(),
                            spec.clone(),
                            commit.clone(),
                            done,
                        ));
                        (waiting, true)
                    }
                }
            };
            let _ = waiting.wait_for(|done| *done).await;
            if let (true, EnvState::Failed { step, output, .. }) = (own, Self::state(env)) {
                return Err(failed(&step, &output));
            }
        }
    }

    /// Runs `commands` in the spec's environment at `commit` with `change` laid over its tree, after
    /// any run before it there: sets the environment up first if needed, and takes the change off.
    pub async fn run(
        self: &Arc<Self>,
        spec: Arc<EnvSpec>,
        commit: CommitSha,
        change: Change,
        commands: Vec<(Command, Duration)>,
    ) -> Result<Used<Vec<Ran>>, UseError> {
        let env = self.env_for(&spec);
        loop {
            let setup_ms = self
                .ready(&env, &spec, &commit)
                .await
                .map_err(UseError::SetupFailed)?;
            if let Some(value) = self.join(&env, &commit, &change, &commands).await {
                return Ok(Used {
                    value,
                    setup_ms,
                    overlay_ms: 0,
                });
            }
            let queue = env.queue.lock().await;
            // Eviction may have taken it while this request waited in the queue.
            let state = Self::state(&env);
            let (from, idle) = match &state {
                EnvState::Ready { tree, .. } => (tree.clone(), false),
                EnvState::Idle { tree, .. } => (tree.clone(), true),
                _ => continue,
            };
            let keeper = env.inner.lock().expect("the env").keeper.clone();
            let keeper = match (idle, keeper) {
                (false, Some(keeper)) => keeper,
                _ => {
                    let started = match self.docker.start(&env.container).await {
                        Some(keeper) => Ok(keeper),
                        None => {
                            self.docker
                                .create(
                                    &env.container,
                                    &env.key,
                                    &spec.image,
                                    &spec.recipe.env,
                                    &env.dir,
                                )
                                .await
                        }
                    };
                    let keeper = started.map_err(UseError::Internal)?;
                    let mut inner = env.inner.lock().expect("the env");
                    inner.keeper = Some(keeper.clone());
                    if idle {
                        inner.state.take(EnvEvent::Started);
                    }
                    keeper
                }
            };
            Self::take(&env, EnvEvent::Acquired);
            let tree = self.tree(&env, &spec.git_dir);
            let ran = {
                let _slot = self
                    .slots
                    .acquire()
                    .await
                    .map_err(|e| UseError::Internal(e.to_string()))?;
                self.run_held(&env, &tree, &from, &commit, &change, &keeper, &commands)
                    .await
            };
            let recovered = tree.recover().await;
            Self::take(
                &env,
                EnvEvent::Released {
                    tree: commit.clone(),
                    at: now(),
                },
            );
            self.save_meta(&env);
            drop(queue);
            // A tree the run broke, its root swapped for a link above all, goes; the next request
            // sets the environment up anew.
            if let (Err(error), _) | (_, Err(UseError::Internal(error))) = (&recovered, &ran) {
                crate::log(&format!(
                    "evicting {} after a run broke its tree: {error}",
                    env.key
                ));
                self.evict(&env).await;
            }
            let measured_at = env.inner.lock().expect("the env").measured_at;
            if now().saturating_sub(measured_at) > 120_000 {
                let this = self.clone();
                let env = env.clone();
                tokio::spawn(async move { this.measure(&env).await });
            }
            let (value, overlay_ms) = ran?;
            return Ok(Used {
                value,
                setup_ms,
                overlay_ms,
            });
        }
    }

    /// The run while it holds the environment: the tree moved to the commit and the change laid over
    /// it, the commands, then nothing left running and the change taken off.
    #[allow(clippy::too_many_arguments)]
    async fn run_held(
        &self,
        env: &Env,
        tree: &Tree,
        from: &CommitSha,
        commit: &CommitSha,
        change: &Change,
        keeper: &str,
        commands: &[(Command, Duration)],
    ) -> Result<(Vec<Ran>, u64), UseError> {
        tree.recover().await.map_err(UseError::Internal)?;
        let started = Instant::now();
        tree.move_to(from, commit)
            .await
            .map_err(UseError::Internal)?;
        let overlay = tree.overlay(change).map_err(|refused| match refused {
            Overlaid::Unsafe(paths) => UseError::UnsafePath(paths),
            Overlaid::Broken(error) => UseError::Internal(error),
        })?;
        let laid = started.elapsed();
        let runner = InContainer {
            docker: &self.docker,
            container: &env.container,
        };
        env.inner.lock().expect("the env").shared = Some(Shared {
            commit: commit.clone(),
            change: change.clone(),
            joined: 0,
            open: true,
        });
        let mut ran = Vec::new();
        for (command, timeout) in commands {
            ran.push(runner.exec(command, *timeout).await);
        }
        if let Some(shared) = env.inner.lock().expect("the env").shared.as_mut() {
            shared.open = false;
        }
        loop {
            let left = env.left.notified();
            {
                let mut inner = env.inner.lock().expect("the env");
                if inner
                    .shared
                    .as_ref()
                    .is_none_or(|shared| shared.joined == 0)
                {
                    inner.shared = None;
                    break;
                }
            }
            left.await;
        }
        // Nothing a run started may still write to the tree while the change comes off.
        if !self.docker.reap(&env.container, keeper).await {
            env.inner.lock().expect("the env").keeper = None;
        }
        let restoring = Instant::now();
        tree.restore(&overlay).await.map_err(UseError::Internal)?;
        Ok((ran, (laid + restoring.elapsed()).as_millis() as u64))
    }

    /// Runs `commands` beside the run holding the tree when it holds it at `commit` with `change`.
    /// Answers None when no such run does, or it is ending or full; the request then queues. A joined
    /// run takes no slot: the run it joins holds one and waits for it.
    async fn join(
        &self,
        env: &Env,
        commit: &CommitSha,
        change: &Change,
        commands: &[(Command, Duration)],
    ) -> Option<Vec<Ran>> {
        env.inner
            .lock()
            .expect("the env")
            .shared
            .as_mut()
            .filter(|shared| {
                shared.open
                    && shared.joined < MAX_JOINED
                    && &shared.commit == commit
                    && &shared.change == change
            })?
            .joined += 1;
        let runner = InContainer {
            docker: &self.docker,
            container: &env.container,
        };
        let mut ran = Vec::new();
        for (command, timeout) in commands {
            ran.push(runner.exec(command, *timeout).await);
        }
        if let Some(shared) = env.inner.lock().expect("the env").shared.as_mut() {
            shared.joined -= 1;
        }
        env.left.notify_waiters();
        Some(ran)
    }

    pub fn list(&self) -> Vec<Summary> {
        let envs = self.envs.lock().expect("the envs");
        let mut list: Vec<Summary> = (envs.values())
            .map(|env| {
                let inner = env.inner.lock().expect("the env");
                Summary {
                    key: env.key.clone(),
                    repo: env.repo.clone(),
                    state: inner.state.phase(),
                    bytes: inner.bytes,
                }
            })
            .collect();
        list.sort_by(|a, b| a.key.cmp(&b.key));
        list
    }
}
