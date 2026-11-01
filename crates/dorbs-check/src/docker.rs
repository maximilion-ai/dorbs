//! Rootless Docker through its CLI: images built from adapters' Dockerfiles, one container per setup
//! step, and one long-lived container per environment that checks and tests exec into.
//!
//! The CLI rather than the Engine API: it speaks to whichever daemon DOCKER_HOST names with the
//! CLI's own version negotiation, builds from a Dockerfile on stdin, and a deadline kills a client,
//! not a connection pool.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::process::{self, Env, ProcessResult, Spec};

/// Where an environment's directory appears inside its containers; the repo is at /env/repo.
pub const ENV_MOUNT: &str = "/env";
pub const REPO_ROOT: &str = "/env/repo";
/// Where runs write reports, inside the environment's directory and outside its tree.
pub const REPORTS: &str = "/env/reports";

/// Every container's environment besides its adapter's: the environment's home, no secrets, no color.
const CONTAINER_ENV: [(&str, &str); 5] = [
    ("HOME", "/env/home"),
    ("TMPDIR", "/tmp"),
    ("CI", "1"),
    ("NO_COLOR", "1"),
    ("FORCE_COLOR", "0"),
];

// Kills every process but pid 1 (docker's init), the keeper whose pid is $1, and this shell, until
// none is left. Builtins only, so the shell starts no process of its own to spare.
const REAP: &str = r#"for round in 1 2 3 4 5; do
  left=0
  for d in /proc/[0-9]*; do
    p=${d#/proc/}
    case "$p" in 1|"$1"|$$) continue ;; esac
    kill -9 "$p" 2>/dev/null && left=1
  done
  [ "$left" = 0 ] && exit 0
done
exit 1"#;

// The keeper is the one process besides pid 1 when the container has just started.
const KEEPER: &str =
    r#"for d in /proc/[0-9]*; do p=${d#/proc/}; case "$p" in 1|$$) ;; *) echo "$p" ;; esac; done"#;

#[derive(Debug, Clone)]
pub struct Limits {
    pub memory: String,
    pub setup_memory: String,
    pub cpus: String,
    pub pids: u32,
    /// The cgroup, such as a systemd slice, every container goes under, so one budget can hold them all.
    pub cgroup_parent: Option<String>,
}

/// How setup steps with network reach out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Egress {
    /// Through an internal network whose only way out is the registry-only egress proxy.
    Proxy,
    /// On Docker's default bridge.
    Open,
}

pub struct Docker {
    prefix: String,
    data_dir: PathBuf,
    limits: Limits,
    egress: Egress,
    /// One build per image at a time.
    builds: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

#[derive(Debug)]
pub struct ImageMissing(pub String);

/// A container this service made.
pub struct Container {
    pub name: String,
    pub running: bool,
}

/// A Docker memory size such as 8g or 512m, in MiB; 0 when it does not parse.
pub fn mebibytes(size: &str) -> u64 {
    let size = size.trim().to_ascii_lowercase();
    let size = size.strip_suffix('b').unwrap_or(&size);
    let (digits, unit) = size.split_at(
        size.find(|c: char| !c.is_ascii_digit())
            .unwrap_or(size.len()),
    );
    let Ok(n) = digits.parse::<u64>() else {
        return 0;
    };
    match unit {
        "" => n / 1024 / 1024,
        "k" => n / 1024,
        "m" => n,
        "g" => n * 1024,
        _ => 0,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Docker {
    pub fn new(prefix: &str, data_dir: &Path, limits: Limits, egress: Egress) -> Docker {
        Docker {
            prefix: prefix.to_owned(),
            data_dir: data_dir.to_owned(),
            limits,
            egress,
            builds: Mutex::new(HashMap::new()),
        }
    }

    fn label(&self) -> String {
        format!("{}.check.env", self.prefix)
    }

    fn setup_network(&self) -> String {
        format!("{}-setup", self.prefix)
    }

    fn egress_name(&self) -> String {
        format!("{}-egress", self.prefix)
    }

    pub fn container_name(&self, env: &str) -> String {
        format!("{}-env-{env}", self.prefix)
    }

    async fn docker(
        &self,
        args: &[&str],
        timeout: Duration,
        stdin: Option<Vec<u8>>,
    ) -> ProcessResult {
        let spec = Spec {
            program: "docker",
            args,
            cwd: &self.data_dir,
            env: Env::Clean(&[]),
            timeout,
            keep: crate::run::KEEP_BYTES,
            stdin,
        };
        process::run(spec)
            .await
            .unwrap_or_else(|error| ProcessResult {
                stdout: String::new(),
                stderr: format!("docker did not start: {error}"),
                exit_code: None,
                timed_out: false,
                truncated: false,
            })
    }

    async fn quick(&self, args: &[&str]) -> ProcessResult {
        self.docker(args, Duration::from_secs(120), None).await
    }

    async fn ok(&self, args: &[&str]) -> Result<String, String> {
        let result = self.quick(args).await;
        match result.exit_code {
            Some(0) => Ok(result.stdout),
            code => Err(format!(
                "docker {} exited {code:?}: {}",
                args[0],
                result.stderr.trim()
            )),
        }
    }

    fn env_args(&self, adapter_env: &BTreeMap<String, String>) -> Vec<String> {
        // Node sizes its heap below what big type checks need, and many images run Node tools; give it
        // three quarters of the container.
        let heap = mebibytes(&self.limits.memory) * 3 / 4;
        let mut env: Vec<(String, String)> = CONTAINER_ENV
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        if heap > 0 {
            env.push((
                "NODE_OPTIONS".to_owned(),
                format!("--max-old-space-size={heap}"),
            ));
        }
        env.extend(adapter_env.iter().map(|(k, v)| (k.clone(), v.clone())));
        env.into_iter()
            .flat_map(|(k, v)| ["-e".to_owned(), format!("{k}={v}")])
            .collect()
    }

    fn limits(&self, memory: &str) -> Vec<String> {
        let parent = (self.limits.cgroup_parent.iter())
            .flat_map(|parent| ["--cgroup-parent".to_owned(), parent.clone()]);
        [
            "--read-only",
            "--tmpfs",
            "/tmp:rw,exec,size=1g",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--memory",
            memory,
            "--memory-swap",
            memory,
            "--pids-limit",
            &self.limits.pids.to_string(),
            "--cpus",
            &self.limits.cpus,
        ]
        .map(str::to_owned)
        .into_iter()
        .chain(parent)
        .collect()
    }

    fn workdir(cwd: &str) -> String {
        if cwd == "." {
            REPO_ROOT.to_owned()
        } else {
            format!("{REPO_ROOT}/{cwd}")
        }
    }

    async fn inspect(&self, tag: &str) -> Option<String> {
        let result = self
            .quick(&["image", "inspect", "--format", "{{.Id}}", tag])
            .await;
        (result.exit_code == Some(0)).then(|| result.stdout.trim().to_owned())
    }

    /// The id of the image `dockerfile` builds, built on first use; environment keys include it, so
    /// a changed Dockerfile or a rebuild starts afresh.
    pub async fn image_id(&self, adapter: &str, dockerfile: &str) -> Result<String, ImageMissing> {
        let tag = format!(
            "dorbs-check/{adapter}:{}",
            &hex(&Sha256::digest(dockerfile.as_bytes()))[..12]
        );
        if let Some(id) = self.inspect(&tag).await {
            return Ok(id);
        }
        let turn = self
            .builds
            .lock()
            .expect("the builds")
            .entry(tag.clone())
            .or_default()
            .clone();
        let _turn = turn.lock().await;
        if let Some(id) = self.inspect(&tag).await {
            return Ok(id);
        }
        crate::log(&format!("building {tag}"));
        let built = self
            .docker(
                &["build", "--quiet", "-t", &tag, "-"],
                Duration::from_secs(20 * 60),
                Some(dockerfile.as_bytes().to_vec()),
            )
            .await;
        match self.inspect(&tag).await {
            Some(id) => Ok(id),
            None => {
                crate::log(&format!(
                    "building {tag} failed: {}",
                    tail(&built.stderr, 2000)
                ));
                Err(ImageMissing(tag))
            }
        }
    }

    /// Runs one setup step in a container of its own, with the network only when it asks for it.
    #[allow(clippy::too_many_arguments)]
    pub async fn setup(
        &self,
        image: &str,
        adapter_env: &BTreeMap<String, String>,
        env_dir: &Path,
        cwd: &str,
        run: &str,
        network: bool,
        timeout: Duration,
    ) -> ProcessResult {
        let name = format!("{}-setup-{}", self.prefix, crate::random_id());
        let mount = format!("{}:{ENV_MOUNT}", env_dir.display());
        let network_name = match (network, self.egress) {
            (false, _) => "none".to_owned(),
            (true, Egress::Proxy) => self.setup_network(),
            (true, Egress::Open) => "bridge".to_owned(),
        };
        let mut args: Vec<String> = [
            "run",
            "--rm",
            "--name",
            &name,
            "--init",
            "--network",
            &network_name,
        ]
        .map(str::to_owned)
        .to_vec();
        args.extend(self.limits(&self.limits.setup_memory));
        args.extend(self.env_args(adapter_env));
        if network && self.egress == Egress::Proxy {
            args.extend(
                proxy_env(&format!("http://{}:3128", self.egress_name()))
                    .into_iter()
                    .flat_map(|pair| ["-e".to_owned(), pair]),
            );
        }
        args.extend(
            [
                "-v",
                &mount,
                "-w",
                &Self::workdir(cwd),
                image,
                "sh",
                "-c",
                run,
            ]
            .map(str::to_owned),
        );
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let result = self.docker(&args, timeout, None).await;
        // Killing the client at the deadline leaves the container running.
        if result.timed_out {
            self.quick(&["rm", "-f", &name]).await;
        }
        result
    }

    /// Makes and starts an environment's container: no network, read-only but for /env and /tmp.
    /// Answers the pid of its keeper process, which `reap` spares.
    pub async fn create(
        &self,
        name: &str,
        env_key: &str,
        image: &str,
        adapter_env: &BTreeMap<String, String>,
        env_dir: &Path,
    ) -> Result<String, String> {
        self.quick(&["rm", "-f", name]).await;
        let label = format!("{}={env_key}", self.label());
        let mount = format!("{}:{ENV_MOUNT}", env_dir.display());
        let mut args: Vec<String> = [
            "run",
            "-d",
            "--name",
            name,
            "--label",
            &label,
            "--init",
            "--network",
            "none",
        ]
        .map(str::to_owned)
        .to_vec();
        args.extend(self.limits(&self.limits.memory));
        args.extend(self.env_args(adapter_env));
        args.extend(["-v", &mount, "-w", REPO_ROOT, image, "sleep", "infinity"].map(str::to_owned));
        self.ok(&args.iter().map(String::as_str).collect::<Vec<_>>())
            .await?;
        self.keeper(name).await
    }

    async fn keeper(&self, container: &str) -> Result<String, String> {
        let output = self.ok(&["exec", container, "sh", "-c", KEEPER]).await?;
        let pids: Vec<&str> = output.lines().filter(|line| !line.is_empty()).collect();
        match pids.as_slice() {
            [pid] => Ok((*pid).to_owned()),
            _ => Err(format!(
                "{container} has no single keeper: {}",
                pids.join(" ")
            )),
        }
    }

    pub async fn exec(
        &self,
        container: &str,
        cwd: &str,
        run: &str,
        timeout: Duration,
    ) -> ProcessResult {
        self.docker(
            &[
                "exec",
                "-w",
                &Self::workdir(cwd),
                container,
                "sh",
                "-c",
                run,
            ],
            timeout,
            None,
        )
        .await
    }

    /// Kills every process in the container but its keeper, so nothing a run started outlives it.
    /// Answers false when it had to stop the container to do so.
    pub async fn reap(&self, container: &str, keeper: &str) -> bool {
        if self
            .quick(&["exec", container, "sh", "-c", REAP, "reap", keeper])
            .await
            .exit_code
            == Some(0)
        {
            return true;
        }
        // Something keeps forking: stopping the container kills it all; the next run starts it again.
        self.quick(&["stop", "--time", "0", container]).await;
        false
    }

    /// Starts a stopped container; answers its keeper's pid, or None when it cannot start.
    pub async fn start(&self, container: &str) -> Option<String> {
        if self.quick(&["start", container]).await.exit_code != Some(0) {
            return None;
        }
        self.keeper(container).await.ok()
    }

    pub async fn stop(&self, container: &str) {
        self.quick(&["stop", "--time", "2", container]).await;
    }

    pub async fn remove(&self, container: &str) {
        self.quick(&["rm", "-f", container]).await;
    }

    /// The containers this service made, by their label.
    pub async fn list(&self) -> Result<Vec<Container>, String> {
        let filter = format!("label={}", self.label());
        let output = self
            .ok(&[
                "ps",
                "-a",
                "--filter",
                &filter,
                "--format",
                "{{.Names}}\t{{.State}}",
            ])
            .await?;
        Ok((output.lines().filter(|line| !line.trim().is_empty()))
            .map(|line| {
                let (name, state) = line.split_once('\t').unwrap_or((line, ""));
                Container {
                    name: name.to_owned(),
                    running: state == "running",
                }
            })
            .collect())
    }

    /// The setup network, with no route out but the egress proxy, which is on it and on the default
    /// bridge. The proxy is `binary`, a static build of this one, in an image of its own.
    pub async fn start_egress(&self, allow: &[String], binary: &Path) -> Result<(), String> {
        if self.egress != Egress::Proxy {
            return Ok(());
        }
        let network = self.setup_network();
        if self
            .quick(&["network", "inspect", &network])
            .await
            .exit_code
            != Some(0)
        {
            self.ok(&["network", "create", "--internal", &network])
                .await?;
        }
        let image = self.egress_image(binary).await?;
        let name = self.egress_name();
        self.quick(&["rm", "-f", &name]).await;
        let mut args: Vec<String> = [
            "run",
            "-d",
            "--name",
            &name,
            "--restart",
            "unless-stopped",
            "--network",
            "bridge",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--memory",
            "256m",
        ]
        .map(str::to_owned)
        .to_vec();
        args.extend(["-e".to_owned(), format!("EGRESS_ALLOW={}", allow.join(","))]);
        args.push(image);
        self.ok(&args.iter().map(String::as_str).collect::<Vec<_>>())
            .await?;
        self.ok(&["network", "connect", &network, &name])
            .await
            .map(drop)
    }

    /// An image of the binary alone, tagged by its hash, whose entry point is the egress proxy.
    async fn egress_image(&self, exe: &Path) -> Result<String, String> {
        let binary = std::fs::read(exe).map_err(|e| format!("{}: {e}", exe.display()))?;
        let tag = format!(
            "dorbs-check/egress:{}",
            &hex(&Sha256::digest(&binary))[..12]
        );
        if self.inspect(&tag).await.is_some() {
            return Ok(tag);
        }
        let context = self.data_dir.join(format!("egress-{}", crate::random_id()));
        std::fs::create_dir_all(&context).map_err(|e| e.to_string())?;
        std::fs::write(context.join("dorbs-check"), &binary).map_err(|e| e.to_string())?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            context.join("dorbs-check"),
            std::fs::Permissions::from_mode(0o755),
        )
        .map_err(|e| e.to_string())?;
        let dockerfile = "FROM scratch\nCOPY dorbs-check /dorbs-check\nENTRYPOINT [\"/dorbs-check\", \"egress\"]\n";
        std::fs::write(context.join("Dockerfile"), dockerfile).map_err(|e| e.to_string())?;
        let path = context.to_string_lossy().into_owned();
        let built = self
            .docker(
                &["build", "--quiet", "-t", &tag, &path],
                Duration::from_secs(300),
                None,
            )
            .await;
        let _ = std::fs::remove_dir_all(&context);
        match built.exit_code {
            Some(0) => Ok(tag),
            _ => Err(format!(
                "building {tag} failed: {}",
                tail(&built.stderr, 2000)
            )),
        }
    }
}

/// Every proxy variable the package managers read: npm, yarn, pnpm, bun, uv, pip, cargo, go and
/// Node's fetch.
fn proxy_env(url: &str) -> Vec<String> {
    let mut env: Vec<String> = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]
        .iter()
        .map(|name| format!("{name}={url}"))
        .collect();
    env.extend([
        format!("npm_config_https_proxy={url}"),
        format!("npm_config_proxy={url}"),
        format!("YARN_HTTPS_PROXY={url}"),
        format!("YARN_HTTP_PROXY={url}"),
        "NODE_USE_ENV_PROXY=1".to_owned(),
        "NO_PROXY=".to_owned(),
    ]);
    env
}

/// The end of `text`, within `max` bytes.
pub fn tail(text: &str, max: usize) -> &str {
    let mut at = text.len().saturating_sub(max);
    while !text.is_char_boundary(at) {
        at += 1;
    }
    &text[at..]
}
