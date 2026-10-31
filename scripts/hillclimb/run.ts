// The hillclimb harness: runs a task suite as dorbs threads, scores each run, and appends it to
// /tmp/dorbs-hillclimb/runs.jsonl. Usage, the metric and the friction rules: README.md beside this file.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";

import { nodeListener, serveGit } from "../gitFixture.ts";
import { runMain, startStack } from "../stack.ts";
import {
  LIMITERS,
  metrics,
  needsProbe,
  probeText,
  replyOf,
  verdict,
  type Metrics,
  type Verdict,
} from "./metrics.ts";
import { runSession } from "./session.ts";
import { suite, type Suite, type Task } from "./tasks.ts";

const OUT_DIR = "/tmp/dorbs-hillclimb";
const OUT = `${OUT_DIR}/runs.jsonl`;
/** Each run's session, every frame stamped, for auditing a verdict or re-deriving a metric. */
const FRAMES = `${OUT_DIR}/frames`;
const DORBS = `${NodeOS.homedir()}/.config/dorbs`;
/** The deployed stages acp-mux reaches: its socket and the log it writes a line per closed session to. */
const DEPLOYED = {
  cloud: { socket: "/tmp/dorbs-cloud.sock", muxLog: `${DORBS}/logs/mux.log` },
  hc: { socket: "/tmp/dorbs-hc.sock", muxLog: `${DORBS}/hc/logs/mux.log` },
} as const;
/** A turn's ceiling, and the done time a failed run scores, so failing is never faster than succeeding. */
const TURN_MS = 600_000;

type Config = {
  readonly stack: "cloud" | "hc" | "local";
  readonly harness: string;
  readonly checkDelayMs: number;
};
const label = (c: Config) => `${c.stack}/${c.harness}/delay${c.checkDelayMs}`;

type Run = {
  readonly batch: string;
  readonly runId: string;
  readonly startedAt: number;
  readonly suite: Suite;
  readonly task: string;
  readonly difficulty: Task["difficulty"];
  readonly config: Config;
  readonly branch: string;
  readonly sessionId: string | undefined;
  readonly setupMs: number;
  readonly metrics: Metrics | undefined;
  readonly verdict: Verdict;
  /** wallMs when the run succeeded, TURN_MS when it failed. */
  readonly doneMs: number;
  readonly probeMs: number | undefined;
  readonly foreignSessions: number | undefined;
  readonly reply: string;
  readonly error: string | undefined;
};

// acp-mux logs a "closed" line per nc session; closures beyond our own are other clients on the stack.
const muxClosures = (muxLog: string | undefined) =>
  muxLog !== undefined && NodeFS.existsSync(muxLog)
    ? NodeFS.readFileSync(muxLog, "utf8")
        .split("\n")
        .filter((l) => l.includes(" closed: ")).length
    : 0;

/** Sessions other than ours that closed since `before`; acp-mux logs our own closure a moment after nc exits. */
const foreignSince = async (muxLog: string, before: number) => {
  const deadline = Date.now() + 5_000;
  while (muxClosures(muxLog) - before < 1 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 200));
  return muxClosures(muxLog) - before - 1;
};

/** Whether `repo`'s origin has `branch`: GitHub for a deployed stack, the local mirror for the local one. */
type RemoteHas = (repo: string, branch: string) => boolean;

const githubHas: RemoteHas = (repo, branch) => {
  const out = NodeChildProcess.spawnSync(
    "gh",
    ["api", `repos/${repo}/git/matching-refs/heads/${branch}`, "--jq", "length"],
    { encoding: "utf8" },
  );
  if (out.status !== 0) throw new Error(`gh api matching-refs for ${repo}: ${out.stderr.trim()}`);
  return Number(out.stdout.trim()) > 0;
};

const runTask = async (
  task: Task,
  config: Config,
  socket: string,
  batch: string,
  remoteHas: RemoteHas,
  setDelay: (ms: number) => void,
): Promise<Run> => {
  setDelay(config.checkDelayMs);
  const runId = NodeCrypto.randomBytes(3).toString("hex");
  const branch = `dorbs/hc-${task.id}-${runId}`;
  const startedAt = Date.now();
  const muxLog = config.stack === "local" ? undefined : DEPLOYED[config.stack].muxLog;
  const closures = muxClosures(muxLog);
  const texts = [task.prompt(branch), ...(needsProbe(task) ? [probeText(task)] : [])];
  const session = await runSession(socket, `/tmp/dorbs-hillclimb-cwd/${runId}`, texts, TURN_MS);
  NodeFS.writeFileSync(`${FRAMES}/${runId}.json`, JSON.stringify(session));
  const foreignSessions = muxLog === undefined ? undefined : await foreignSince(muxLog, closures);
  const [turn, probe] = session.turns;
  const remoteBranch = remoteHas(task.repo, branch);
  const verdictNow = verdict(task, branch, turn, probe, remoteBranch);
  const m = turn === undefined ? undefined : metrics(turn);
  return {
    batch,
    runId,
    startedAt,
    suite: task.suite,
    task: task.id,
    difficulty: task.difficulty,
    config,
    branch,
    sessionId: session.sessionId,
    setupMs: session.setupMs,
    metrics: m,
    verdict: verdictNow,
    doneMs: verdictNow.success && m !== undefined ? m.wallMs : TURN_MS,
    probeMs: probe?.wallMs,
    foreignSessions,
    reply: turn === undefined ? "" : replyOf(turn).slice(0, 600),
    error: session.error ?? turn?.error,
  };
};

const s = (ms: number | undefined) =>
  ms === undefined || !Number.isFinite(ms) ? "-" : (ms / 1000).toFixed(1);

const median = (xs: ReadonlyArray<number>): number => {
  const sorted = xs.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? NaN)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

const range = (xs: ReadonlyArray<number>) =>
  xs.length === 0 ? "-" : `${s(Math.min(...xs))}-${s(Math.max(...xs))}`;

const line = (run: Run) => {
  const m = run.metrics;
  const errors = (m?.failedToolCalls ?? 0) + (run.error === undefined ? 0 : 1);
  return (
    `${run.verdict.success ? "ok" : "FAIL"}${run.verdict.valid ? "" : " INVALID"} ${run.task} [${label(run.config)}] ` +
    `wall=${s(m?.wallMs)}s green=${s(m?.firstGreenMs)}s errors=${errors} work=${m?.toolCalls ?? 0}calls/${m?.writes ?? 0}writes ` +
    `check=${m?.checkMs.length ?? 0} test=${m?.testMs.length ?? 0} model=${m?.modelCalls ?? 0} friction=${m?.frictionCount ?? 0} ` +
    `limiter=${m?.limiter ?? "-"} foreign=${run.foreignSessions ?? "-"}` +
    (run.verdict.failures.length > 0 ? ` why=${run.verdict.failures.join("; ")}` : "") +
    (run.error === undefined ? "" : ` error=${run.error.slice(0, 200)}`)
  );
};

const mode = <A>(xs: ReadonlyArray<A>): A | undefined => {
  const counts = new Map<A, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].toSorted((a, b) => b[1] - a[1])[0]?.[0];
};

/** The summary table per config: one row per task, then the primary metric and what bounds the time. */
export const report = (runs: ReadonlyArray<Run>) => {
  for (const [config, inConfig] of Map.groupBy(runs, (r) => label(r.config))) {
    const valid = inConfig.filter((r) => r.verdict.valid);
    console.log(
      `\n### ${config}: ${valid.length} valid runs of ${inConfig.length}, batches ${[...new Set(inConfig.map((r) => r.batch))].join(",")}\n`,
    );
    console.log(
      "| task | diff | ok | done s p50 (range) | wall s p50 | first green s | tools | failed | check n / p50 s | test n / p50 s | model calls | friction | limiter |",
    );
    console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    const taskMedians: number[] = [];
    for (const [task, rs] of Map.groupBy(valid, (r) => r.task)) {
      const ms = rs.flatMap((r) => (r.metrics === undefined ? [] : [r.metrics]));
      const done = median(rs.map((r) => r.doneMs));
      taskMedians.push(done);
      const per = (f: (m: Metrics) => number) => median(ms.map(f)).toFixed(0);
      console.log(
        `| ${task} | ${rs[0]?.difficulty} | ${rs.filter((r) => r.verdict.success).length}/${rs.length} | ` +
          `${s(done)} (${range(rs.map((r) => r.doneMs))}) | ${s(median(ms.map((m) => m.wallMs)))} | ` +
          `${s(median(ms.map((m) => m.firstGreenMs ?? NaN)))} | ${per((m) => m.toolCalls)} | ${per((m) => m.failedToolCalls)} | ` +
          `${per((m) => m.checkMs.length)} / ${s(median(ms.flatMap((m) => m.checkMs)))} | ` +
          `${per((m) => m.testMs.length)} / ${s(median(ms.flatMap((m) => m.testMs)))} | ${per((m) => m.modelCalls)} | ` +
          `${per((m) => m.frictionCount)} | ${mode(ms.map((m) => m.limiter)) ?? "-"} |`,
      );
    }
    const ms = valid.flatMap((r) => (r.metrics === undefined ? [] : [r.metrics]));
    const split = { model: 0, check: 0, clone: 0, tools: 0 };
    for (const m of ms) for (const key of LIMITERS) split[key] += m.split[key];
    const total = Object.values(split).reduce((a, b) => a + b, 0) || 1;
    const friction: Record<string, number> = {};
    for (const m of ms)
      for (const [id, n] of Object.entries(m.friction)) friction[id] = (friction[id] ?? 0) + n;
    const errors = valid.reduce(
      (n, r) => n + (r.metrics?.failedToolCalls ?? 0) + (r.error === undefined ? 0 : 1),
      0,
    );
    console.log(
      `\nprimary: median over tasks of done time = ${s(median(taskMedians))} s (failed run = ${TURN_MS / 1000} s)\n` +
        `success: ${valid.filter((r) => r.verdict.success).length}/${valid.length}; ` +
        `friction per run p50 ${median(ms.map((m) => m.frictionCount))}, total ${JSON.stringify(friction)}\n` +
        `errors: ${errors} failed tool calls or session errors; work: ${ms.reduce((n, m) => n + m.toolCalls, 0)} tool calls, ` +
        `${ms.reduce((n, m) => n + m.writes, 0)} writes, ${ms.reduce((n, m) => n + m.checkMs.length + m.testMs.length, 0)} check/test calls; ` +
        `infra errors ${ms.reduce((n, m) => n + m.infraErrors, 0)}\n` +
        `time share: ${Object.entries(split)
          .map(([k, v]) => `${k} ${((100 * v) / total).toFixed(0)}%`)
          .join(", ")}`,
    );
  }
};

const readRuns = (): Run[] =>
  NodeFS.existsSync(OUT)
    ? NodeFS.readFileSync(OUT, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** A local HTTP server that forwards to `target` after the current delay. */
const delayProxy = async (target: string) => {
  let delayMs = 0;
  const server = NodeHttp.createServer(
    nodeListener(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.delete("host");
      const response = await fetch(`${target}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? null
            : await request.arrayBuffer(),
      });
      const out = new Headers(response.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(await response.arrayBuffer(), { status: response.status, headers: out });
    }),
  );
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    }),
  );
  return {
    url: `http://127.0.0.1:${port}`,
    setDelay: (ms: number) => (delayMs = ms),
    close: () => server.close(),
  };
};

/** The local stack: the Worker under alchemy dev, cloning a local mirror of the sandbox, checked by the devbox. */
const localStack = async (tasks: ReadonlyArray<Task>, harness: "pi" | "opencode") => {
  const repos = new Set(tasks.map((t) => t.repo));
  const [repo] = repos;
  if (repos.size !== 1 || repo === undefined)
    throw new Error("--stack local runs tasks of one repo");
  const root = NodeFS.mkdtempSync("/tmp/dorbs-hillclimb-git-");
  const mirror = NodeChildProcess.spawnSync(
    "gh",
    ["repo", "clone", repo, `${root}/repo.git`, "--", "--mirror", "--quiet"],
    {
      encoding: "utf8",
    },
  );
  if (mirror.status !== 0) throw new Error(`mirroring ${repo}: ${mirror.stderr.trim()}`);
  const git = NodeHttp.createServer(nodeListener(serveGit(root)));
  const gitPort = await new Promise<number>((resolve) =>
    git.listen(0, "127.0.0.1", () => {
      const address = git.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    }),
  );
  const proxy = await delayProxy(NodeFS.readFileSync(`${DORBS}/check-url`, "utf8").trim());
  const stack = await startStack({
    repo,
    harness,
    source: { url: `http://127.0.0.1:${gitPort}/repo.git` },
    checker: {
      url: proxy.url,
      token: NodeFS.readFileSync(`${DORBS}/check-token-devbox`, "utf8").trim(),
    },
    cwd: NodeFS.mkdtempSync("/tmp/dorbs-hillclimb-local-"),
    model: {
      provider: "openrouter",
      id: "deepseek/deepseek-v4.1-flash",
      openrouterKey: NodeFS.readFileSync(`${DORBS}/openrouter-key`, "utf8").trim(),
    },
  });
  const remoteHas: RemoteHas = (_, branch) =>
    NodeChildProcess.spawnSync("git", [
      "--git-dir",
      `${root}/repo.git`,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]).status === 0;
  const close = () => {
    proxy.close();
    git.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  };
  return { socket: stack.socketPath, setDelay: proxy.setDelay, remoteHas, close };
};

const main = async () => {
  const { positionals, values } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      suite: { type: "string", default: "sandbox" },
      runs: { type: "string", default: "1" },
      tasks: { type: "string" },
      stack: { type: "string", default: "cloud" },
      harness: { type: "string", default: "pi" },
      "check-delay": { type: "string", default: "0" },
      batch: { type: "string" },
    },
  });
  if (positionals[0] === "report") {
    const batches = values.batch?.split(",");
    report(readRuns().filter((r) => batches === undefined || batches.includes(r.batch)));
    return;
  }
  if (values.suite !== "sandbox" && values.suite !== "real")
    throw new Error("--suite is sandbox or real");
  if (values.stack !== "cloud" && values.stack !== "hc" && values.stack !== "local")
    throw new Error("--stack is cloud, hc or local");
  if (values.harness !== "pi" && values.harness !== "opencode")
    throw new Error("--harness is pi or opencode");
  const wanted = values.tasks?.split(",");
  const tasks = suite(values.suite).filter((t) => wanted === undefined || wanted.includes(t.id));
  if (tasks.length === 0) throw new Error(`no tasks match ${values.tasks}`);
  const delays = values["check-delay"].split(",").map(Number);
  if (values.stack !== "local" && (delays.some((d) => d !== 0) || values.harness !== "pi")) {
    throw new Error(
      "a deployed stack runs as deployed (HARNESS=pi, no added delay); use --stack local to vary them",
    );
  }
  const stack =
    values.stack !== "local"
      ? {
          socket: DEPLOYED[values.stack].socket,
          setDelay: () => {},
          remoteHas: githubHas,
          close: () => {},
        }
      : await localStack(tasks, values.harness);
  const batch = NodeCrypto.randomBytes(3).toString("hex");
  NodeFS.mkdirSync(FRAMES, { recursive: true });
  console.log(
    `batch ${batch}: ${tasks.length} tasks x ${values.runs} runs x ${delays.length} configs on ${values.stack}`,
  );
  const runs: Run[] = [];
  // Round-robin over runs, tasks and configs, so drift and other clients' load land on every cell alike.
  try {
    for (let i = 0; i < Number(values.runs); i += 1) {
      for (const task of tasks) {
        for (const checkDelayMs of i % 2 === 0 ? delays : delays.toReversed()) {
          const config: Config = { stack: values.stack, harness: values.harness, checkDelayMs };
          const run = await runTask(
            task,
            config,
            stack.socket,
            batch,
            stack.remoteHas,
            stack.setDelay,
          );
          NodeFS.appendFileSync(OUT, `${JSON.stringify(run)}\n`);
          runs.push(run);
          console.log(line(run));
        }
      }
    }
  } finally {
    stack.close();
  }
  report(runs);
};

await runMain(main);
