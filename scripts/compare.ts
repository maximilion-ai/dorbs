// Prompts N sessions at once on a local stack, on Pi then on OpenCode, and prints one TSV row per harness.
//   node scripts/compare.ts [count] [scripted|openrouter]   (openrouter reads OPENROUTER_API_KEY)
// CPU and peak RSS are the workerd process's over the prompts; storage is each session's SQLite after workerd exits.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { prompt, runMain, startStack, stopAll, TS_PROJECT } from "./stack.ts";

const CWD = "/tmp/dorbs-compare-project";
const REPO = "dorbs/compare";
const LOCAL = NodePath.resolve(import.meta.dirname, "../apps/agent-worker/.alchemy/local");

const count = Number(process.argv[2] ?? "10");
const provider = process.argv[3] === "openrouter" ? "openrouter" : "scripted";
const openrouterKey = process.env.OPENROUTER_API_KEY ?? "";
if (provider === "openrouter" && openrouterKey === "") {
  console.log("not ok OPENROUTER_API_KEY is not set");
  process.exit(1);
}

/** The scripted model's clone, write, check run; the real model gets soak.ts's conc prompt. */
const PROMPT = (n: number) =>
  provider === "scripted"
    ? "e2e"
    : `Clone ${REPO}. Use write_file to create src/load${n}.ts exporting function load${n}(xs: number[]): number ` +
      "that returns the sum. Run the check tool, fix any errors, then reply with one sentence. Do not commit or push.";

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

/** This checkout's workerd processes; other projects on the machine run their own. */
const workerds = () =>
  NodeChildProcess.spawnSync(
    "/usr/bin/pgrep",
    ["-f", `${NodePath.resolve(import.meta.dirname, "..")}/node_modules/.*/bin/workerd `],
    { encoding: "utf8" },
  )
    .stdout.split("\n")
    .filter(Boolean)
    .map(Number);

/** CPU seconds a process has used, from ps's [[dd-]hh:]mm:ss.cc. */
const cpuSeconds = (pid: number) => {
  const time = NodeChildProcess.spawnSync("/bin/ps", ["-o", "time=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
  const [days, clock] = time.includes("-") ? time.split("-") : ["0", time];
  return (clock ?? "")
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), Number(days) * 86_400);
};

/** Bytes of a session's SQLite by what keeps them: the agent loop's tables, the ACP history, and the rest. */
const storage = (file: string) => {
  // A copy, so SQLite can replay the write-ahead log workerd left beside it.
  const copy = NodePath.join(NodeFS.mkdtempSync("/tmp/dorbs-compare-db-"), "session.sqlite");
  NodeFS.copyFileSync(file, copy);
  if (NodeFS.existsSync(`${file}-wal`)) NodeFS.copyFileSync(`${file}-wal`, `${copy}-wal`);
  const rows = NodeChildProcess.execFileSync(
    "/usr/bin/sqlite3",
    [
      copy,
      "SELECT CASE WHEN name LIKE 'pi\\_%' ESCAPE '\\' OR name LIKE 'opencode\\_%' ESCAPE '\\' THEN 'loop' " +
        "WHEN name LIKE 'acp\\_%' ESCAPE '\\' THEN 'history' ELSE 'rest' END, sum(pgsize) FROM dbstat GROUP BY 1",
    ],
    { encoding: "utf8" },
  );
  NodeFS.rmSync(NodePath.dirname(copy), { recursive: true, force: true });
  const bytes = Object.fromEntries(
    rows
      .trim()
      .split("\n")
      .map((line) => line.split("|"))
      .map(([bucket, size]) => [bucket, Number(size)]),
  );
  return { loop: bytes.loop ?? 0, history: bytes.history ?? 0, rest: bytes.rest ?? 0 };
};

const kb = (bytes: number) => Math.round(bytes / 1024);

const run = async (harness: "pi" | "opencode") => {
  const before = new Set(workerds());
  const stack = await startStack({
    repo: REPO,
    harness,
    source: { fixture: TS_PROJECT },
    cwd: CWD,
    model: {
      provider,
      id: provider === "scripted" ? "scripted" : "deepseek/deepseek-v4.1-flash",
      openrouterKey,
    },
  });
  const pids = workerds().filter((pid) => !before.has(pid));
  const cpuBefore = pids.reduce((total, pid) => total + cpuSeconds(pid), 0);
  let rssKb = 0;
  const sample = () => {
    const out = NodeChildProcess.spawnSync("/bin/ps", ["-o", "rss=", "-p", pids.join(",")], {
      encoding: "utf8",
    }).stdout;
    rssKb = Math.max(
      rssKb,
      out.split("\n").reduce((total, line) => total + Number(line || 0), 0),
    );
  };
  const sampler = setInterval(sample, 250);
  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const session = await stack.startNc();
      const created = await session.client.request(
        2,
        "session/new",
        { cwd: CWD, mcpServers: [] },
        60_000,
      );
      const sessionId: string = created.result.sessionId;
      const t = performance.now();
      const answer = await session.client
        .request(3, "session/prompt", prompt(sessionId, PROMPT(i + 1)), 300_000)
        .catch((error: unknown) => ({ result: { stopReason: String(error) }, error: undefined }));
      const ms = Math.round(performance.now() - t);
      const tools = session.client
        .updates(sessionId)
        .filter((update) => update.sessionUpdate === "tool_call").length;
      session.nc.kill("SIGTERM");
      return { ms, stop: answer.result?.stopReason ?? JSON.stringify(answer.error), tools };
    }),
  );
  clearInterval(sampler);
  sample();
  const cpu = pids.reduce((total, pid) => total + cpuSeconds(pid), 0) - cpuBefore;
  const wallMs = Date.now() - startedAt;
  await stopAll();
  const files = NodeFS.readdirSync(LOCAL)
    .filter((dir) => dir.endsWith("-AcpSession"))
    .flatMap((dir) =>
      NodeFS.readdirSync(NodePath.join(LOCAL, dir))
        .filter((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite")
        .map((file) => NodePath.join(LOCAL, dir, file))
        .filter((file) => NodeFS.statSync(file).mtimeMs >= startedAt),
    );
  const sizes = files.map(storage);
  const ms = results.map((r) => r.ms).toSorted((a, b) => a - b);
  const mean = (pick: (s: ReturnType<typeof storage>) => number) =>
    kb(sizes.reduce((total, s) => total + pick(s), 0) / Math.max(1, sizes.length));
  return [
    harness,
    count,
    results.filter((r) => r.stop === "end_turn").length,
    percentile(ms, 50),
    percentile(ms, 90),
    ms.at(-1) ?? 0,
    wallMs,
    results.reduce((total, r) => total + r.tools, 0),
    cpu.toFixed(2),
    (cpu / count).toFixed(3),
    Math.round(rssKb / 1024),
    sizes.length,
    mean((s) => s.loop + s.history + s.rest),
    mean((s) => s.loop),
    mean((s) => s.history),
    mean((s) => s.rest),
  ];
};

await runMain(async () => {
  NodeFS.mkdirSync(CWD, { recursive: true });
  const rows = [];
  for (const harness of ["pi", "opencode"] as const) rows.push(await run(harness));
  console.log(
    [
      "harness",
      "sessions",
      "end_turn",
      "p50_ms",
      "p90_ms",
      "max_ms",
      "wall_ms",
      "tool_calls",
      "workerd_cpu_s",
      "cpu_s_per_session",
      "workerd_rss_max_mb",
      "dbs",
      "kb_per_session",
      "kb_loop",
      "kb_history",
      "kb_rest",
    ].join("\t"),
  );
  for (const row of rows) console.log(row.join("\t"));
});
