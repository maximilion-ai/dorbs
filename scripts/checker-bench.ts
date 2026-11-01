// The checker's benchmark on its host: fixed checks and tests from the celld2 eval's PRs, sent at once as the Worker
// sends them, to a bench instance under 4 CPUs and 16 GiB. BENCH_DIR (~/dorbs-checker-bench) holds its files.
//   node scripts/checker-bench.ts up [--binary PATH] [--recipe FILE] | run [--label NAME] | down [--purge]
// up starts the unit dorbs-checker-bench on port 8791, run writes results/<time>-<label>.json, down stops it.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const REPO = "maximilionai/t3code-eval-celld";
const REPO_URL = `https://github.com/${REPO}.git`;
const BASE = "8d1fb7dc7e5007637c14fb7cf9ed4f5443f619f9";
/** 12 checks and 8 tests, the eval's mix (125 to 82), in the order they are submitted: PR and its head. */
const JOBS: ReadonlyArray<readonly ["check" | "test", number, string]> = [
  ["check", 107, "99680f3bb1b38e110ffa32907cfc0a8666d36eef"],
  ["check", 113, "f53d5b06442ecfd4939bccfacfd3f16aed6d4078"],
  ["test", 179, "c56ffda007b56ccf2b213404de2897f181ccd7c3"],
  ["check", 108, "8d296be7eb603f0f5fc5bb53121f714adc7b64f4"],
  ["test", 120, "cf049457cd2c5cb87a6eba21a5fbac07f032748f"],
  ["check", 127, "1b3e9eb4a52f6da31ddc3edd4de214ff9aa690dd"],
  ["check", 138, "6e0bdad41f409399b274a47b96ea610e51118392"],
  ["test", 167, "41ce47a179602767b1b3176405037d118d105f28"],
  ["check", 136, "9eb3018902ee454494ea4a2d68f36ed3d7f3686d"],
  ["test", 192, "ea03302106f170f619dfab99b46f193d421bbb43"],
  ["check", 116, "232476d64819fcd2d60e1c673dfc9ed158ac22c3"],
  ["check", 155, "979be30fb5071583657b6cbdb62246b1724f3ca0"],
  ["test", 151, "ba5742735beb6970d8ee6b59c3c12e6811e90d3b"],
  ["check", 115, "87bff942856ee1f604a8262f769aad88f439a57f"],
  ["test", 144, "046aac61144e6fdf44c6af716abd71d7693c35a0"],
  ["check", 126, "7955eb937a0c528729c4b984a69265b3240f6c41"],
  ["check", 195, "a3e1e8b4b1ba262c3a80a1ae1bc5c98b97e07c69"],
  ["test", 152, "63a0d3564406e4705e88409908dc8d9b1d41d346"],
  ["check", 200, "0338e93efcc0eb7378ad99b561c9d1499ab2f0b9"],
  ["test", 112, "8c36e9db70aa3d0311b5ea8ed6ee6c6785185467"],
];

const BUDGET = { cpus: 4, mib: 16 * 1024 };
const UNIT = "dorbs-checker-bench";
const PREFIX = "dorbsbench";
const PORT = 8791;
const POLL_MS = 1000;
const HOME = NodeOS.homedir();
const DIR = process.env.BENCH_DIR ?? NodePath.join(HOME, "dorbs-checker-bench");
const DATA_DIR = NodePath.join(DIR, "data");
const TOKEN_FILE = NodePath.join(DIR, "check-token");
const ENV_FILE = NodePath.join(DIR, "checker.env");
const ROOT = NodePath.resolve(import.meta.dirname, "..");
const UID = process.getuid?.() ?? 0;
const CGROUP_USER = `/sys/fs/cgroup/user.slice/user-${UID}.slice/user@${UID}.service`;
/** With SLICE=1, the service and its containers run in this slice, which holds the whole budget. */
const SLICE = "dorbs-checker-bench.slice";
const SLICE_FILE = NodePath.join(HOME, ".config/systemd/user", SLICE);

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    binary: { type: "string" },
    recipe: { type: "string" },
    label: { type: "string" },
    purge: { type: "boolean" },
  },
});

const sh = (command: string, args: ReadonlyArray<string>, input?: string) =>
  NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });

const quiet = (command: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });

// up takes REPLICAS (1), RUN_SLOTS (1), CONTAINER_CPUS (3.5), CONTAINER_MEMORY and SETUP_MEMORY (10240m), and for
// the service's own unit SERVICE_CPU (50%) and SERVICE_MEMORY (768M); it refuses limits past the budget. With SLICE=1
// the budget holds as one slice around the service and every container instead, so each may use what the others
// leave. --recipe gives the repo's registration that recipe, as an operator would.

/** A Docker or systemd size such as 5632m, 6g or 768M, in MiB. */
const mib = (size: string) => {
  const match = /^(\d+(?:\.\d+)?)([kmgKMG]?)$/.exec(size);
  if (match === null) throw new Error(`${size} is not a size`);
  const factor = { k: 1 / 1024, m: 1, g: 1024, "": 1 / 1024 / 1024 }[match[2]!.toLowerCase()]!;
  return Number(match[1]) * factor;
};

const up = async () => {
  if (quiet("systemctl", ["--user", "is-active", "--quiet", UNIT]).status === 0) {
    throw new Error(`${UNIT} runs already; stop it with down`);
  }
  const limits = {
    REPLICAS: process.env.REPLICAS ?? "1",
    RUN_SLOTS: process.env.RUN_SLOTS ?? "1",
    CONTAINER_CPUS: process.env.CONTAINER_CPUS ?? "3.5",
    CONTAINER_MEMORY: process.env.CONTAINER_MEMORY ?? "10240m",
    SETUP_MEMORY: process.env.SETUP_MEMORY ?? "10240m",
  };
  const service = {
    cpu: process.env.SERVICE_CPU ?? "50%",
    memory: process.env.SERVICE_MEMORY ?? "768M",
  };
  const slice = process.env.SLICE === "1";
  // One repo: each replica holds one container at a time, a setup step's or its own, and the egress proxy 256m.
  const replicas = slice ? 1 : Number(limits.REPLICAS);
  const cpus =
    replicas * Number(limits.CONTAINER_CPUS) + (slice ? 0 : Number.parseFloat(service.cpu) / 100);
  const memory =
    replicas * Math.max(mib(limits.CONTAINER_MEMORY), mib(limits.SETUP_MEMORY)) +
    (slice ? 0 : 256 + mib(service.memory));
  if (cpus > BUDGET.cpus || memory > BUDGET.mib) {
    throw new Error(
      `the limits take ${cpus} CPUs and ${memory} MiB, past ${JSON.stringify(BUDGET)}`,
    );
  }
  NodeFS.mkdirSync(NodePath.join(DIR, "bin"), { recursive: true });
  NodeFS.mkdirSync(DATA_DIR, { recursive: true });
  const binary = NodePath.join(DIR, "bin/dorbs-check");
  NodeFS.copyFileSync(
    values.binary ?? NodePath.join(ROOT, "target/x86_64-unknown-linux-musl/release/dorbs-check"),
    binary,
  );
  NodeFS.copyFileSync(
    NodePath.join(ROOT, "crates/dorbs-check/deploy/start.sh"),
    NodePath.join(DIR, "bin/start.sh"),
  );
  if (!NodeFS.existsSync(TOKEN_FILE)) {
    NodeFS.writeFileSync(TOKEN_FILE, NodeCrypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  const production: ReadonlyArray<{ id: string; recipe?: unknown }> = JSON.parse(
    NodeFS.readFileSync(NodePath.join(HOME, "dorbs-checker/repos.json"), "utf8"),
  );
  const repos = NodePath.join(DIR, "repos.json");
  NodeFS.writeFileSync(
    repos,
    JSON.stringify(
      production
        .filter((repo) => repo.id === REPO)
        .map((repo) =>
          values.recipe === undefined
            ? repo
            : { ...repo, recipe: JSON.parse(NodeFS.readFileSync(values.recipe, "utf8")) },
        ),
      null,
      2,
    ),
  );
  const appId = /^GITHUB_APP_ID=(.*)$/m.exec(
    NodeFS.readFileSync(NodePath.join(HOME, ".config/dorbs/checker.env"), "utf8"),
  )?.[1];
  const env = {
    DATA_DIR,
    REPOS_FILE: repos,
    HOST: "127.0.0.1",
    PORT: String(PORT),
    DOCKER_HOST: process.env.DOCKER_HOST ?? `unix:///run/user/${UID}/docker.sock`,
    ...(appId === undefined ? {} : { GITHUB_APP_ID: appId }),
    CHECK_TIMEOUT: "10 minutes",
    // Every run sends the same requests; remembered answers would make the second one free.
    REMEMBER_CHECKS: "0",
    DISK_BUDGET: String(24 * 1024 ** 3),
    CONTAINER_PREFIX: PREFIX,
    CHECK_TOKEN_FILE: TOKEN_FILE,
    DORBS_CHECK: binary,
    ...limits,
    ...(slice ? { CONTAINER_CGROUP_PARENT: SLICE } : {}),
  };
  NodeFS.writeFileSync(
    ENV_FILE,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
  );
  if (slice) {
    NodeFS.mkdirSync(NodePath.dirname(SLICE_FILE), { recursive: true });
    NodeFS.writeFileSync(
      SLICE_FILE,
      `[Slice]\nCPUQuota=${BUDGET.cpus * 100}%\nMemoryMax=${BUDGET.mib}M\nMemorySwapMax=0\n`,
    );
    sh("systemctl", ["--user", "daemon-reload"]);
  }
  sh("systemd-run", [
    "--user",
    `--unit=${UNIT}`,
    "--collect",
    `--property=EnvironmentFile=${ENV_FILE}`,
    ...(slice
      ? [`--slice=${SLICE}`]
      : [`--property=CPUQuota=${service.cpu}`, `--property=MemoryMax=${service.memory}`]),
    "--property=KillMode=mixed",
    NodePath.join(DIR, "bin/start.sh"),
  ]);
  // It listens once its egress image is built, which takes a minute for a new binary.
  const deadline = Date.now() + 5 * 60 * 1000;
  while ((await request("GET", "/environments").catch(() => undefined))?.status !== 200) {
    if (Date.now() > deadline) throw new Error(`${UNIT} did not answer on port ${PORT}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log(
    `${UNIT} on port ${PORT}: ${limits.REPLICAS} replicas, ${limits.RUN_SLOTS} slots, ` +
      `${limits.CONTAINER_CPUS} CPUs and ${limits.CONTAINER_MEMORY} each; ` +
      (slice
        ? `all in ${SLICE} (${BUDGET.cpus} CPUs, ${BUDGET.mib} MiB)`
        : `service ${service.cpu}, ${service.memory}`),
  );
};

// down

const down = () => {
  quiet("systemctl", ["--user", "stop", UNIT]);
  const containers = sh("docker", ["ps", "-aq", "--filter", `name=^${PREFIX}-`]).split("\n");
  if (containers.some(Boolean)) sh("docker", ["rm", "-f", ...containers.filter(Boolean)]);
  const networks = sh("docker", ["network", "ls", "-q", "--filter", `name=^${PREFIX}-`]).split(
    "\n",
  );
  if (networks.some(Boolean)) sh("docker", ["network", "rm", ...networks.filter(Boolean)]);
  if (values.purge === true) {
    NodeFS.rmSync(DATA_DIR, { recursive: true, force: true });
    if (NodeFS.existsSync(SLICE_FILE)) {
      NodeFS.rmSync(SLICE_FILE);
      sh("systemctl", ["--user", "daemon-reload"]);
    }
  }
  console.log(`${UNIT} stopped${values.purge === true ? ", its data removed" : ""}`);
};

// run

type Change = {
  files: ReadonlyArray<{ path: string; content: string }>;
  deleted: ReadonlyArray<string>;
};
type Job = {
  id: string;
  kind: "check" | "test";
  pr: number;
  body: { repo: string; commit: string; change: Change; files?: ReadonlyArray<string> };
};

/** The PR heads in a repo of the bench's own, each a change against BASE; tests run the test files it touched. */
const jobs = (): ReadonlyArray<Job> => {
  const gitDir = NodePath.join(DIR, "jobs.git");
  const git = (...args: ReadonlyArray<string>) => sh("git", ["--git-dir", gitDir, ...args]);
  if (!NodeFS.existsSync(gitDir)) sh("git", ["init", "--quiet", "--bare", gitDir]);
  const missing = JOBS.filter(
    ([, , head]) => quiet("git", ["--git-dir", gitDir, "cat-file", "-e", head]).status !== 0,
  );
  if (missing.length > 0) {
    git(
      "fetch",
      "--quiet",
      "--depth=1",
      REPO_URL,
      BASE,
      ...missing.map(([, pr]) => `refs/pull/${pr}/head:refs/pull/${pr}`),
    );
  }
  return JOBS.map(([kind, pr, head], n) => {
    const fetched = git("rev-parse", `refs/pull/${pr}`).trim();
    if (fetched !== head) throw new Error(`PR ${pr} is at ${fetched}, not ${head}`);
    const files: Array<{ path: string; content: string }> = [];
    const deleted: Array<string> = [];
    const entries = git("diff", "--name-status", "--no-renames", "-z", BASE, head).split("\0");
    for (let i = 0; i + 1 < entries.length; i += 2) {
      const [status, path] = [entries[i]!, entries[i + 1]!];
      if (status === "D") deleted.push(path);
      else files.push({ path, content: git("show", `${head}:${path}`) });
    }
    const tests = files
      .map((file) => file.path)
      .filter((path) => /\.test\.[cm]?[jt]sx?$/.test(path));
    if (kind === "test" && tests.length === 0) throw new Error(`PR ${pr} touches no test file`);
    return {
      id: `${String(n + 1).padStart(2, "0")}-${kind}-${pr}`,
      kind,
      pr,
      body: {
        repo: REPO,
        commit: BASE,
        change: { files, deleted },
        ...(kind === "test" ? { files: tests } : {}),
      },
    };
  });
};

const token = () => NodeFS.readFileSync(TOKEN_FILE, "utf8").trim();

const request = async (method: "GET" | "POST", path: string, body?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
};

type Diagnostic = { severity: number };
type CheckRun = {
  id: string;
  status: string;
  durationMs: number;
  diagnostics: ReadonlyArray<Diagnostic>;
  output: ReadonlyArray<string>;
  truncated: boolean;
};
type Answer = {
  _tag: string;
  envKey?: string | undefined;
  durationMs?: number | undefined;
  setupMs?: number | undefined;
  overlayMs?: number | undefined;
  queueMs?: number | undefined;
  checks?: ReadonlyArray<CheckRun>;
  status?: string | undefined;
  passed?: number | undefined;
  failed?: number | undefined;
  skipped?: number | undefined;
  step?: string | undefined;
  output?: string | undefined;
  reason?: unknown;
};

type JobResult = {
  id: string;
  kind: Job["kind"];
  pr: number;
  latencyMs: number;
  http?: number | undefined;
  error?: string | undefined;
  tag?: string | undefined;
  envKey?: string | undefined;
  durationMs?: number | undefined;
  setupMs?: number | undefined;
  overlayMs?: number | undefined;
  runMs?: number | undefined;
  queueMs?: number | undefined;
  checks?: ReadonlyArray<{
    id: string;
    status: string;
    durationMs: number;
    errors: number;
    warnings: number;
    truncated: boolean;
    output?: ReadonlyArray<string>;
  }>;
  status?: string | undefined;
  passed?: number | undefined;
  failed?: number | undefined;
  skipped?: number | undefined;
  step?: string | undefined;
  output?: string | undefined;
  reason?: unknown;
};

const timing = (result: Answer): { runMs?: number; queueMs?: number } => {
  if (result.durationMs === undefined) return {};
  const fixed = (result.setupMs ?? 0) + (result.overlayMs ?? 0);
  const checksMs = result.checks?.reduce((sum, run) => sum + run.durationMs, 0);
  if (result.queueMs !== undefined) {
    return {
      queueMs: result.queueMs,
      runMs: Math.round(checksMs ?? result.durationMs - fixed - result.queueMs),
    };
  }
  if (checksMs === undefined) return {};
  return { runMs: Math.round(checksMs), queueMs: Math.round(result.durationMs - fixed - checksMs) };
};

/** Posts a job and polls for its answer, as the Worker's Checker does. */
const submit = async (job: Job, started: number): Promise<JobResult> => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const posted = await request("POST", `/jobs/${job.kind}`, job.body);
  let answer = posted;
  if (posted.status === 202) {
    const id: string = JSON.parse(posted.text).id;
    do {
      await sleep(POLL_MS);
      answer = await request("GET", `/jobs/${id}`);
    } while (answer.status === 202);
  }
  const latencyMs = Math.round(performance.now() - started);
  if (answer.status !== 200) {
    return {
      id: job.id,
      kind: job.kind,
      pr: job.pr,
      latencyMs,
      http: answer.status,
      error: answer.text.slice(0, 500),
    };
  }
  const result: Answer = JSON.parse(answer.text);
  const count = (diagnostics: ReadonlyArray<Diagnostic>, severity: number) =>
    diagnostics.filter((d) => d.severity === severity).length;
  return {
    id: job.id,
    kind: job.kind,
    pr: job.pr,
    latencyMs,
    tag: result._tag,
    envKey: result.envKey,
    durationMs: result.durationMs,
    setupMs: result.setupMs,
    overlayMs: result.overlayMs,
    // durationMs counts from the request's arrival. A checker that answers queueMs says what its runs took; for
    // one that does not, a check's runs leave the queue, and a test's run stays unknown.
    ...timing(result),
    ...(result.checks === undefined
      ? {}
      : {
          checks: result.checks.map((run) => ({
            id: run.id,
            status: run.status,
            durationMs: run.durationMs,
            errors: count(run.diagnostics, 1),
            warnings: count(run.diagnostics, 2),
            truncated: run.truncated,
            ...(run.status === "passed" ? {} : { output: run.output.slice(0, 40) }),
          })),
        }),
    ...(result._tag === "TestResult"
      ? {
          status: result.status,
          passed: result.passed,
          failed: result.failed,
          skipped: result.skipped,
          ...(result.status === "passed" && result.passed !== undefined
            ? {}
            : { output: result.output?.slice(-4000) }),
        }
      : {}),
    ...(result._tag === "SetupFailed"
      ? { step: result.step, output: result.output?.slice(-2000) }
      : {}),
    ...(result._tag === "Rejected" ? { reason: result.reason } : {}),
  };
};

type Counters = { usage: number; throttled: number; oomKills: number };

const counters = (cgroup: string): Counters | undefined => {
  try {
    const cpu = NodeFS.readFileSync(`${cgroup}/cpu.stat`, "utf8");
    const memory = NodeFS.readFileSync(`${cgroup}/memory.events`, "utf8");
    const field = (text: string, name: string) =>
      Number(new RegExp(`^${name} (\\d+)$`, "m").exec(text)?.[1] ?? 0);
    return {
      usage: field(cpu, "usage_usec"),
      throttled: field(cpu, "throttled_usec"),
      oomKills: field(memory, "oom_kill"),
    };
  } catch {
    return undefined;
  }
};

const memoryCurrent = (cgroup: string) => {
  try {
    return Number(NodeFS.readFileSync(`${cgroup}/memory.current`, "utf8"));
  } catch {
    return 0;
  }
};

/**
 * Samples the bench containers' cgroups and the service unit's each second. A container's CPU counts from its
 * first sample, or from zero when it started during the run; one that goes between samples loses its last second.
 */
const sampler = () => {
  const unit = `/sys/fs/cgroup${sh("systemctl", ["--user", "show", "--property=ControlGroup", "--value", UNIT]).trim()}`;
  const containers = new Map<
    string,
    { name: string; first: Counters; last: Counters; peak: number }
  >();
  const service = { first: counters(unit), last: counters(unit), peak: 0 };
  const samples: Array<[number, number, number]> = [];
  const t0 = performance.now();
  let previous = { at: t0, usage: 0 };
  // A container's cgroup, from its main process; found once, as it lives as long as the container.
  const cgroups = new Map<string, string>();
  const cgroupOf = (id: string) => {
    if (!cgroups.has(id)) {
      const pid = quiet("docker", ["inspect", "-f", "{{.State.Pid}}", id]).stdout.trim();
      const path = /^0::(.*)$/m.exec(quiet("cat", [`/proc/${pid}/cgroup`]).stdout)?.[1];
      if (path === undefined) return undefined;
      cgroups.set(id, `/sys/fs/cgroup${path}`);
    }
    return cgroups.get(id);
  };
  let known: ReadonlyArray<[string, string]> = [];
  const list = () => {
    known = sh("docker", [
      "ps",
      "--no-trunc",
      "--filter",
      `name=^${PREFIX}-`,
      "--format",
      "{{.ID}} {{.Names}}",
    ])
      .split("\n")
      .filter(Boolean)
      .map((line): [string, string] => {
        const [id = "", name = ""] = line.split(" ");
        return [id, name];
      });
  };
  list();
  const zero = { usage: 0, throttled: 0, oomKills: 0 };
  for (const [id, name] of known) {
    const cgroup = cgroupOf(id);
    const now = cgroup === undefined ? undefined : counters(cgroup);
    if (now !== undefined) containers.set(id, { name, first: now, last: now, peak: 0 });
  }
  const slice = `${CGROUP_USER}/${SLICE}`;
  const sliced = { first: counters(slice), last: counters(slice), peak: 0 };
  const sample = () => {
    let memory = 0;
    sliced.last = counters(slice) ?? sliced.last;
    sliced.peak = Math.max(sliced.peak, memoryCurrent(slice));
    for (const [id, name] of known) {
      const cgroup = cgroupOf(id);
      if (cgroup === undefined) continue;
      const now = counters(cgroup);
      if (now === undefined) continue;
      const entry = containers.get(id) ?? { name, first: zero, last: zero, peak: 0 };
      const bytes = memoryCurrent(cgroup);
      memory += bytes;
      containers.set(id, { ...entry, last: now, peak: Math.max(entry.peak, bytes) });
    }
    service.last = counters(unit) ?? service.last;
    const serviceBytes = memoryCurrent(unit);
    service.peak = Math.max(service.peak, serviceBytes);
    const at = performance.now();
    const usage = [...containers.values()].reduce(
      (sum, c) => sum + c.last.usage - c.first.usage,
      0,
    );
    const cores = (usage - previous.usage) / 1000 / (at - previous.at);
    previous = { at, usage };
    samples.push([
      Math.round((at - t0) / 1000),
      Math.round(cores * 100) / 100,
      Math.round((memory + serviceBytes) / 2 ** 20),
    ]);
  };
  const sampling = setInterval(sample, 1000);
  const listing = setInterval(list, 5000);
  return () => {
    clearInterval(sampling);
    clearInterval(listing);
    sample();
    const seconds = (performance.now() - t0) / 1000;
    const cpuSeconds = (pick: (c: { first: Counters; last: Counters }) => number) =>
      Math.round([...containers.values()].reduce((sum, c) => sum + pick(c), 0) / 1e4) / 100;
    const containerCpuS = cpuSeconds((c) => c.last.usage - c.first.usage);
    const serviceCpuS =
      service.first === undefined || service.last === undefined
        ? undefined
        : Math.round((service.last.usage - service.first.usage) / 1e4) / 100;
    return {
      containerCpuS,
      containerThrottledS: cpuSeconds((c) => c.last.throttled - c.first.throttled),
      oomKills: [...containers.values()].reduce(
        (sum, c) => sum + c.last.oomKills - c.first.oomKills,
        0,
      ),
      serviceCpuS,
      /** Containers' and service's CPU over the run, as a share of the budget's cores for as long. */
      budgetCpuPct:
        Math.round(((containerCpuS + (serviceCpuS ?? 0)) / (seconds * BUDGET.cpus)) * 1000) / 10,
      /** The largest sum of the containers' and the service's memory in one sample. */
      memoryPeakMiB: Math.max(0, ...samples.map(([, , m]) => m)),
      containers: [...containers.values()].map((c) => ({
        name: c.name,
        cpuS: Math.round((c.last.usage - c.first.usage) / 1e4) / 100,
        throttledS: Math.round((c.last.throttled - c.first.throttled) / 1e4) / 100,
        memoryPeakMiB: Math.round(c.peak / 2 ** 20),
        oomKills: c.last.oomKills - c.first.oomKills,
      })),
      serviceMemoryPeakMiB: Math.round(service.peak / 2 ** 20),
      // With SLICE=1, what the whole slice used: the service, its containers and anything they started.
      ...(sliced.first === undefined || sliced.last === undefined
        ? {}
        : {
            sliceCpuS: Math.round((sliced.last.usage - sliced.first.usage) / 1e4) / 100,
            sliceThrottledS:
              Math.round((sliced.last.throttled - sliced.first.throttled) / 1e4) / 100,
            sliceMemoryPeakMiB: Math.round(sliced.peak / 2 ** 20),
          }),
      samples,
    };
  };
};

const stats = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (q: number) =>
    Math.round((sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0) * 10) / 10;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / Math.max(1, sorted.length);
  return { p50: at(0.5), p90: at(0.9), max: at(1), mean: Math.round(mean * 10) / 10 };
};

const seconds = (ms: number | undefined) => (ms === undefined ? "" : (ms / 1000).toFixed(1));

const run = async () => {
  if (quiet("systemctl", ["--user", "is-active", "--quiet", UNIT]).status !== 0) {
    throw new Error(`${UNIT} does not run; start it with up`);
  }
  const set = jobs();
  const environments = async () => JSON.parse((await request("GET", "/environments")).text);
  const before = await environments();
  const stop = sampler();
  const started = performance.now();
  const results = await Promise.all(set.map((job) => submit(job, started)));
  const makespanMs = Math.round(performance.now() - started);
  const usage = stop();
  const after = await environments();
  const ok = results.filter((r) => r.tag === "CheckResult" || r.tag === "TestResult");
  const summary = {
    jobs: results.length,
    answered: ok.length,
    makespanS: makespanMs / 1000,
    jobsPerMin: Math.round((results.length / (makespanMs / 60000)) * 100) / 100,
    latencyS: stats(results.map((r) => r.latencyMs / 1000)),
    serviceS: stats(ok.map((r) => (r.durationMs ?? 0) / 1000)),
    checkRunS: stats(
      ok.flatMap((r) => (r.kind === "check" && r.runMs !== undefined ? [r.runMs / 1000] : [])),
    ),
    testRunS: stats(
      ok.flatMap((r) => (r.kind === "test" && r.runMs !== undefined ? [r.runMs / 1000] : [])),
    ),
    queueS: stats(ok.flatMap((r) => (r.queueMs === undefined ? [] : [r.queueMs / 1000]))),
    setupS: Math.max(0, ...ok.map((r) => (r.setupMs ?? 0) / 1000)),
    ...usage,
  };
  const label = values.label ?? "run";
  const file = NodePath.join(
    DIR,
    "results",
    `${new Date().toISOString().replaceAll(":", "")}-${label}.json`,
  );
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const config = NodeFS.readFileSync(ENV_FILE, "utf8");
  const binary = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(NodePath.join(DIR, "bin/dorbs-check")))
    .digest("hex");
  NodeFS.writeFileSync(
    file,
    JSON.stringify(
      { label, at: new Date().toISOString(), binary, config, summary, before, after, results },
      null,
      1,
    ),
  );

  const rows = results.map((r) => [
    r.id,
    seconds(r.latencyMs),
    seconds(r.durationMs),
    seconds(r.setupMs),
    seconds(r.queueMs),
    seconds(r.runMs),
    r.checks !== undefined
      ? r.checks
          .map((c) => `${c.id}=${c.status}/${c.errors}e${c.warnings}w ${seconds(c.durationMs)}s`)
          .join(" ")
      : r.status !== undefined
        ? `${r.status} ${r.passed ?? "?"}p ${r.failed ?? "?"}f`
        : (r.tag ?? `HTTP ${r.http}`),
  ]);
  const head = ["job", "e2e s", "service s", "setup s", "queue s", "run s", "result"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  for (const row of [head, ...rows])
    console.log(row.map((cell, i) => cell.padEnd(widths[i]!)).join("  "));
  console.log(
    `\n${label}: ${summary.answered}/${summary.jobs} answered, makespan ${summary.makespanS} s, ` +
      `${summary.jobsPerMin} jobs/min, e2e p50 ${summary.latencyS.p50} s max ${summary.latencyS.max} s, ` +
      `setup ${summary.setupS} s\n` +
      `CPU ${summary.containerCpuS} s containers (${summary.containerThrottledS} s throttled) + ` +
      `${summary.serviceCpuS} s service = ${summary.budgetCpuPct}% of ${BUDGET.cpus} CPUs; ` +
      `memory peak ${summary.memoryPeakMiB} MiB, ${summary.oomKills} OOM kills\n${file}`,
  );
};

const [action] = positionals;
if (action === "up") await up();
else if (action === "down") down();
else if (action === "run") await run();
else {
  console.error("usage: checker-bench.ts up [--binary PATH] | run [--label NAME] | down [--purge]");
  process.exit(2);
}
