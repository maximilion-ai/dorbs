// Times dorbs cloud threads (a) against opencode on the devbox (b), same model and prompts.
//   node scripts/bench.ts run <a|b> <edit|survey> <count> [par]   appends to /tmp/dorbs-bench/runs.jsonl
//   node scripts/bench.ts report [sinceMs]                         p50/p90 table
//   node scripts/bench.ts cloudflare                               Worker and DO CPU per side-a batch

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeReadline from "node:readline";

import { acpClient, prompt, T3_INITIALIZE_LINE } from "./stack.ts";

const SOCKET = "/tmp/dorbs-cloud.sock";
const CWD = "/tmp/dorbs-cloud-project";
const DORBS = `${NodeOS.homedir()}/.config/dorbs`;
const OUT_DIR = "/tmp/dorbs-bench";
const OUT = `${OUT_DIR}/runs.jsonl`;
const DEVBOX = "devbox-dev";
const DEVBOX_MODEL = "openrouter/deepseek/deepseek-v4.1-flash";
const REPO = "maximilionai/dorbs-sandbox";

type Task = "edit" | "survey";

const promptFor = (task: Task, name: string) =>
  task === "edit"
    ? `Clone the GitHub repo ${REPO} into the current working directory. Add src/${name}.ts exporting a function ${name}(xs: number[]): number ` +
      "that returns the sum of xs. Type check the project (use your check tool if you have one, " +
      "otherwise run `npx --yes -p typescript tsc --noEmit` in the clone), fix any errors, then commit " +
      `the change on a new local branch bench/${name}. Do not push and do not open a pull request. ` +
      "Reply with one sentence."
    : `Clone the GitHub repo ${REPO} into the current working directory, describe what the repo is in two sentences, and list all its files. ` +
      "Do not change anything.";

type ToolCall = {
  readonly kind: string;
  readonly label: string;
  readonly ms: number;
  readonly ok: boolean;
};

type Run = {
  readonly side: "a" | "b";
  readonly task: Task;
  readonly mode: "seq" | "par";
  readonly batch: string;
  readonly ok: boolean;
  readonly totalMs: number;
  readonly ttftMs?: number;
  readonly setupMs?: number;
  readonly tools: ReadonlyArray<ToolCall>;
  readonly toolUnionMs: number;
  readonly modelCalls?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly costUsd?: number;
  readonly committed: boolean;
  readonly pushed: boolean;
  readonly cpuS?: number;
  readonly peakRssMb?: number;
  readonly host?: HostCost;
  readonly reply: string;
  readonly foreignSessions?: number;
  readonly error?: string;
};

const classify = (label: string): string => {
  if (/git clone|gh repo clone/u.test(label)) return "clone";
  if (/typecheck|\bcheck\b|\btsc\b/u.test(label)) return "typecheck";
  if (/^(write|edit)|^(write_file|edit_file)\b|apply_patch/u.test(label)) return "write";
  if (/(^|`|&& ?|; ?)git /u.test(label)) return "git";
  return "other";
};

/** Wall time covered by at least one tool call. */
const unionMs = (intervals: ReadonlyArray<readonly [number, number]>) => {
  let covered = 0;
  let end = -Infinity;
  for (const [s, e] of intervals.toSorted((x, y) => x[0] - y[0])) {
    if (e <= end) continue;
    covered += e - Math.max(s, end);
    end = e;
  }
  return covered;
};

type HostCost = {
  readonly cpuS: number;
  readonly peakRssMb: number;
  readonly byRole: Record<string, { cpuS: number; peakRssMb: number }>;
  readonly samples: number;
};

const parseCpu = (time: string) => {
  // macOS ps: [[dd-]hh:]mm:ss.ss
  const parts = time.split(":").map(Number);
  return parts.reduce((acc, part) => acc * 60 + part, 0);
};

const pidFile = (name: string) =>
  Number(NodeFS.readFileSync(`${DORBS}/${name}.pid`, "utf8").trim());

/** Samples acp-mux, the typecheck tree, cloudflared and the given nc pids every `ms`. */
const sampleMacMini = (ncPids: () => ReadonlyArray<number>, ms = 100) => {
  const roots: Record<string, number> = {
    "acp-mux": pidFile("mux"),
    typecheck: pidFile("typecheck"),
    cloudflared: pidFile("tunnel"),
  };
  const baseline = new Map<number, number>();
  const lastCpu = new Map<number, { role: string; cpu: number }>();
  const peakByRole: Record<string, number> = {};
  let peakTotal = 0;
  let samples = 0;
  const tick = (first: boolean) => {
    const ps = NodeChildProcess.spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,rss=,time="], {
      encoding: "utf8",
    });
    const rows = ps.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/u))
      .map(([pid, ppid, rss, time]) => ({
        pid: Number(pid),
        ppid: Number(ppid),
        rssKb: Number(rss),
        cpu: parseCpu(time ?? "0"),
      }));
    const children = new Map<number, number[]>();
    for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
    const role = new Map<number, string>();
    const mark = (pid: number, name: string) => {
      role.set(pid, name);
      for (const child of children.get(pid) ?? []) mark(child, name);
    };
    for (const [name, pid] of Object.entries(roots)) mark(pid, name);
    for (const pid of ncPids()) role.set(pid, "nc");
    const rssByRole: Record<string, number> = {};
    for (const row of rows) {
      const name = role.get(row.pid);
      if (name === undefined) continue;
      if (first) baseline.set(row.pid, row.cpu);
      lastCpu.set(row.pid, { role: name, cpu: row.cpu });
      rssByRole[name] = (rssByRole[name] ?? 0) + row.rssKb;
    }
    let total = 0;
    for (const [name, kb] of Object.entries(rssByRole)) {
      peakByRole[name] = Math.max(peakByRole[name] ?? 0, kb);
      total += kb;
    }
    peakTotal = Math.max(peakTotal, total);
    samples += 1;
  };
  tick(true);
  const timer = setInterval(() => tick(false), ms);
  return (): HostCost => {
    clearInterval(timer);
    tick(false);
    const byRole: HostCost["byRole"] = {};
    let cpuS = 0;
    for (const [pid, { role, cpu }] of lastCpu) {
      const used = cpu - (baseline.get(pid) ?? 0);
      byRole[role] ??= { cpuS: 0, peakRssMb: Math.round((peakByRole[role] ?? 0) / 1024) };
      byRole[role].cpuS += used;
      cpuS += used;
    }
    return { cpuS, peakRssMb: Math.round(peakTotal / 1024), byRole, samples };
  };
};

const runA = async (task: Task, name: string, onNc: (pid: number) => void) => {
  const t0 = performance.now();
  const nc = NodeChildProcess.spawn("/usr/bin/nc", ["-U", SOCKET], {
    cwd: CWD,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (nc.pid !== undefined) onNc(nc.pid);
  const client = acpClient(nc);
  // acpClient keeps frames, not arrival times; stamp them here as they land.
  const stamps: number[] = [];
  NodeReadline.createInterface({ input: nc.stdout }).on("line", () =>
    stamps.push(performance.now()),
  );
  const at = (frame: (typeof client.frames)[number]) => stamps[client.frames.indexOf(frame)] ?? NaN;
  try {
    client.sendLine(T3_INITIALIZE_LINE);
    await client.next((f) => f.id === 1073741824, 60_000, "initialize");
    const created = await client.request(2, "session/new", { cwd: CWD, mcpServers: [] }, 60_000);
    const sessionId: string = created.result.sessionId;
    const setupMs = at(created) - t0;
    const answer = await client.request(
      3,
      "session/prompt",
      prompt(sessionId, promptFor(task, name)),
      900_000,
    );
    const end = at(answer);
    const frames = client.frames.filter(
      (f) => f.method === "session/update" && f.params?.sessionId === sessionId,
    );
    const firstModel = frames.find((f) =>
      ["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(
        f.params.update.sessionUpdate,
      ),
    );
    const started = new Map<string, { label: string; at: number }>();
    const tools: ToolCall[] = [];
    const intervals: Array<[number, number]> = [];
    // A model call ends where tool calls start; a new one starts with the first frame after they all finish.
    let modelCalls = 0;
    let inModel = false;
    for (const f of frames) {
      const u = f.params.update;
      if (u.sessionUpdate === "tool_call") {
        if (!inModel) modelCalls += 1;
        inModel = false;
        started.set(u.toolCallId, { label: u.title, at: at(f) });
      } else if (
        u.sessionUpdate === "tool_call_update" &&
        (u.status === "completed" || u.status === "failed")
      ) {
        const s = started.get(u.toolCallId);
        if (s === undefined) continue;
        started.delete(u.toolCallId);
        tools.push({
          kind: classify(s.label.replaceAll("`", "")),
          label: s.label,
          ms: at(f) - s.at,
          ok: u.status === "completed",
        });
        intervals.push([s.at, at(f)]);
      } else if (
        u.sessionUpdate === "agent_message_chunk" ||
        u.sessionUpdate === "agent_thought_chunk"
      ) {
        if (!inModel && started.size === 0) {
          modelCalls += 1;
          inModel = true;
        }
      }
    }
    const reply = frames
      .filter((f) => f.params.update.sessionUpdate === "agent_message_chunk")
      .map((f) => f.params.update.content?.text ?? "")
      .join("");
    return {
      ok: answer.result?.stopReason === "end_turn",
      totalMs: end - t0,
      setupMs,
      ttftMs: firstModel === undefined ? undefined : at(firstModel) - t0,
      tools,
      toolUnionMs: unionMs(intervals),
      modelCalls,
      committed: tools.some(
        (t) => t.kind === "git" && / commit /u.test(` ${t.label.replaceAll("`", "")} `) && t.ok,
      ),
      pushed: tools.some((t) => t.kind === "git" && /git push/u.test(t.label.replaceAll("`", ""))),
      reply: reply.slice(0, 400),
      ...(answer.error ? { error: answer.error.message } : {}),
      model: created.result.configOptions?.[0]?.currentValue,
    };
  } finally {
    nc.stdin.end();
    setTimeout(() => nc.kill("SIGTERM"), 3_000).unref();
  }
};

// The key travels on ssh stdin into one command's environment; it is never printed or written on the devbox.
const REMOTE = [
  "read -r K; read -r P",
  'd=$(mktemp -d /tmp/bench-XXXXXX); t=$(mktemp /tmp/bench-time-XXXXXX); cd "$d"',
  'echo "T0 $(date +%s%3N)" >&2',
  `OPENROUTER_API_KEY="$K" /usr/bin/time -v -o "$t" opencode run --standalone --format json --auto -m ${DEVBOX_MODEL} "$P" </dev/null`,
  'echo "EXIT $?" >&2; echo "T1 $(date +%s%3N)" >&2; cat "$t" >&2',
  'git -C "$d" ls-remote --heads origin "bench/*" 2>/dev/null | sed "s/^/PUSHED /" >&2',
  'cd /; rm -rf "$d" "$t"',
].join("; ");

const runB = async (task: Task, name: string) => {
  const key = NodeFS.readFileSync(`${DORBS}/openrouter-key`, "utf8").trim();
  const ssh = NodeChildProcess.spawn("ssh", [DEVBOX, REMOTE], { stdio: ["pipe", "pipe", "pipe"] });
  ssh.stdin.end(`${key}\n${promptFor(task, name)}\n`);
  let out = "";
  let err = "";
  ssh.stdout.on("data", (c: Buffer) => (out += c.toString()));
  ssh.stderr.on("data", (c: Buffer) => (err += c.toString()));
  await new Promise((resolve) => ssh.once("exit", resolve));
  const marker = (re: RegExp) => Number(re.exec(err)?.[1] ?? NaN);
  const t0 = marker(/^T0 (\d+)/mu);
  const t1 = marker(/^T1 (\d+)/mu);
  const events = out
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
  const tools: ToolCall[] = [];
  const intervals: Array<[number, number]> = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let firstPart = Infinity;
  for (const e of events) {
    const part = e.part ?? {};
    if (part.time?.start !== undefined) firstPart = Math.min(firstPart, part.time.start);
    if (e.type === "tool_use") {
      const input = part.state?.input ?? {};
      const label =
        part.tool === "shell" || part.tool === "bash"
          ? String(input.command ?? "")
          : `${part.tool} ${input.filePath ?? input.path ?? ""}`;
      const { start, end } = part.state?.time ?? part.time ?? {};
      tools.push({
        kind: classify(label),
        label: label.slice(0, 400),
        ms: end - start,
        ok: part.state?.status === "completed" && (part.state?.metadata?.metadata?.exit ?? 0) === 0,
      });
      firstPart = Math.min(firstPart, start);
      intervals.push([start, end]);
    }
    if (e.type === "step_finish") {
      tokensIn += (part.tokens?.input ?? 0) + (part.tokens?.cache?.read ?? 0);
      tokensOut += (part.tokens?.output ?? 0) + (part.tokens?.reasoning ?? 0);
      costUsd += part.cost ?? 0;
    }
  }
  const time = (re: RegExp) => Number(re.exec(err)?.[1] ?? NaN);
  const reply = events
    .filter((e) => e.type === "text")
    .map((e) => e.part.text)
    .join("")
    .trim();
  return {
    ok: /^EXIT 0$/mu.test(err) && events.length > 0,
    totalMs: t1 - t0,
    ttftMs: Number.isFinite(firstPart) ? firstPart - t0 : undefined,
    tools,
    toolUnionMs: unionMs(intervals),
    modelCalls: events.filter((e) => e.type === "step_start").length,
    tokensIn,
    tokensOut,
    costUsd,
    committed: tools.some((t) => /git( -c \S+)* commit/u.test(t.label) && t.ok),
    pushed: /^PUSHED /mu.test(err) || tools.some((t) => /git push/u.test(t.label)),
    cpuS: time(/User time \(seconds\): ([\d.]+)/u) + time(/System time \(seconds\): ([\d.]+)/u),
    peakRssMb: Math.round(time(/Maximum resident set size \(kbytes\): (\d+)/u) / 1024),
    reply: reply.slice(0, 400),
    ...(events.length === 0 ? { error: err.split("\n").slice(0, 20).join("\n") } : {}),
  };
};

// acp-mux logs one "closed" line per nc session, so closures beyond our own are other clients sharing the stack.
const muxClosures = () =>
  NodeFS.readFileSync(`${DORBS}/logs/mux.log`, "utf8")
    .split("\n")
    .filter((l) => l.includes(" closed: ")).length;

const foreignSince = async (before: number, own: number) => {
  const deadline = Date.now() + 5_000;
  while (muxClosures() - before < own && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 200));
  return muxClosures() - before - own;
};

const run = async (side: "a" | "b", task: Task, count: number, parallel: boolean) => {
  NodeFS.mkdirSync(OUT_DIR, { recursive: true });
  const batch = NodeCrypto.randomBytes(3).toString("hex");
  const ncPids: number[] = [];
  const one = async (i: number) => {
    const name = `bench${batch}n${i}`;
    const stop = side === "a" && !parallel ? sampleMacMini(() => ncPids) : undefined;
    const closures = muxClosures();
    const startedAt = Date.now();
    const result =
      side === "a"
        ? await runA(task, name, (pid) => ncPids.push(pid)).catch((e: Error) => ({
            ok: false,
            error: e.message,
          }))
        : await runB(task, name).catch((e: Error) => ({ ok: false, error: e.message }));
    const endedAt = Date.now();
    const host = stop?.();
    const foreignSessions = side === "a" && !parallel ? await foreignSince(closures, 1) : undefined;
    const record = {
      side,
      task,
      mode: parallel ? "par" : "seq",
      batch,
      name,
      startedAt,
      endedAt,
      foreignSessions,
      ...result,
      ...(host ? { host, cpuS: host.cpuS, peakRssMb: host.peakRssMb } : {}),
    };
    const line = JSON.stringify(record);
    NodeFS.appendFileSync(OUT, `${line}\n`);
    // Print what was written, which is what report reads back.
    const r: Partial<Run> = JSON.parse(line);
    console.log(
      `${side} ${task} ${name} ok=${r.ok} total=${((r.totalMs ?? NaN) / 1000).toFixed(1)}s ttft=${((r.ttftMs ?? NaN) / 1000).toFixed(1)}s ` +
        `tools=${r.tools?.map((t) => `${t.kind}:${(t.ms / 1000).toFixed(1)}`).join(",")} committed=${r.committed} cpu=${r.cpuS?.toFixed(2)} rss=${r.peakRssMb}` +
        (r.error ? ` error=${r.error.slice(0, 200)}` : ""),
    );
  };
  if (!parallel) {
    for (let i = 0; i < count; i += 1) await one(i);
    return;
  }
  const t0 = performance.now();
  const startedAt = Date.now();
  const closures = muxClosures();
  const stop = side === "a" ? sampleMacMini(() => ncPids) : undefined;
  await Promise.all(Array.from({ length: count }, (_, i) => one(i)));
  const host = stop?.();
  const wallMs = performance.now() - t0;
  const endedAt = Date.now();
  const foreignSessions = side === "a" ? await foreignSince(closures, count) : undefined;
  NodeFS.appendFileSync(
    OUT,
    `${JSON.stringify({ side, task, mode: "par-batch", batch, startedAt, endedAt, wallMs, foreignSessions, host })}\n`,
  );
  console.log(
    `batch ${batch} wall=${(wallMs / 1000).toFixed(1)}s foreign=${foreignSessions} host=${JSON.stringify(host)}`,
  );
};

const pct = (xs: ReadonlyArray<number>, p: number) => {
  const sorted = xs.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
};

// Mac mini samples count for side a only when no other client used the stack during the run.
const clean = (rs: ReadonlyArray<Run>) =>
  rs.filter((r) => r.side === "b" || r.foreignSessions === 0);

/** Pass `since` (epoch ms) to keep only runs that started after it. */
const report = (since = 0) => {
  const lines = NodeFS.readFileSync(OUT, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((l) => since === 0 || (l.startedAt ?? 0) >= since);
  const runs: Run[] = lines.filter((l) => l.mode === "seq" || l.mode === "par");
  const groups = Map.groupBy(runs, (r) => `${r.task} ${r.mode}`);
  const fmt = (xs: number[], scale = 1, digits = 1) => {
    const [a, b] = [pct(xs, 50), pct(xs, 90)].map((x) =>
      Number.isNaN(x) ? "—" : (x / scale).toFixed(digits),
    );
    return `${a} / ${b}`;
  };
  for (const [group, rs] of [...groups].toSorted(([x], [y]) => x.localeCompare(y))) {
    const bySide = (side: string) => rs.filter((r) => r.side === side);
    const [a, b] = [bySide("a"), bySide("b")];
    const tool = (rs2: Run[], kind: string) =>
      rs2.flatMap((r) => r.tools.filter((t) => t.kind === kind).map((t) => t.ms));
    const rows: Array<[string, (rs2: Run[]) => string]> = [
      ["runs (ok/total)", (x) => `${x.filter((r) => r.ok).length}/${x.length}`],
      ["committed", (x) => `${x.filter((r) => r.committed).length}/${x.length}`],
      [
        "total turn s",
        (x) =>
          fmt(
            x.map((r) => r.totalMs),
            1000,
          ),
      ],
      [
        "time to first token s",
        (x) =>
          fmt(
            x.map((r) => r.ttftMs ?? NaN),
            1000,
          ),
      ],
      [
        "session setup s",
        (x) =>
          fmt(
            x.map((r) => r.setupMs ?? NaN),
            1000,
            2,
          ),
      ],
      [
        "tool wall (union) s",
        (x) =>
          fmt(
            x.map((r) => r.toolUnionMs),
            1000,
          ),
      ],
      [
        "model + harness s",
        (x) =>
          fmt(
            x.map((r) => r.totalMs - r.toolUnionMs - (r.setupMs ?? 0)),
            1000,
          ),
      ],
      ...["clone", "write", "typecheck", "git", "other"].map(
        (k) =>
          [
            `tool ${k} s (n)`,
            (x: Run[]) => `${fmt(tool(x, k), 1000, 2)} (${tool(x, k).length})`,
          ] as [string, (rs2: Run[]) => string],
      ),
      [
        "tool calls / run",
        (x) =>
          fmt(
            x.map((r) => r.tools.length),
            1,
            0,
          ),
      ],
      [
        "model calls / run",
        (x) =>
          fmt(
            x.map((r) => r.modelCalls ?? NaN),
            1,
            0,
          ),
      ],
      [
        "model + harness s / model call",
        (x) =>
          fmt(
            x.map((r) => (r.totalMs - r.toolUnionMs - (r.setupMs ?? 0)) / (r.modelCalls ?? NaN)),
            1000,
            2,
          ),
      ],
      [
        "tokens in / run (k)",
        (x) =>
          fmt(
            x.map((r) => r.tokensIn ?? NaN),
            1000,
          ),
      ],
      [
        "tokens out / run",
        (x) =>
          fmt(
            x.map((r) => r.tokensOut ?? NaN),
            1,
            0,
          ),
      ],
      [
        "cost / run $",
        (x) =>
          fmt(
            x.map((r) => r.costUsd ?? NaN),
            1,
            4,
          ),
      ],
      [
        "foreign sessions during run",
        (x) =>
          fmt(
            x.map((r) => r.foreignSessions ?? NaN),
            1,
            0,
          ),
      ],
      [
        "host CPU s / run (clean)",
        (x) =>
          fmt(
            clean(x).map((r) => r.cpuS ?? NaN),
            1,
            2,
          ),
      ],
      [
        "host peak RSS MB (clean)",
        (x) =>
          fmt(
            clean(x).map((r) => r.peakRssMb ?? NaN),
            1,
            0,
          ),
      ],
    ];
    console.log(`\n### ${group} (p50 / p90)\n\n| metric | A cloud | B devbox |\n|---|---|---|`);
    for (const [label, f] of rows) console.log(`| ${label} | ${f(a)} | ${f(b)} |`);
  }
  for (const batch of lines.filter((l) => l.mode === "par-batch")) {
    console.log(
      `\nbatch ${batch.side} ${batch.task} wall ${(batch.wallMs / 1000).toFixed(1)}s host ${JSON.stringify(batch.host ?? null)}`,
    );
  }
};

/** The deployed Worker's script name, as Cloudflare's analytics key it. */
const WORKER_SCRIPT = process.env.WORKER_SCRIPT;

const cloudflare = async () => {
  if (WORKER_SCRIPT === undefined) throw new Error("WORKER_SCRIPT must name the deployed Worker");
  const token = NodeFS.readFileSync(`${DORBS}/cf-editor-token`, "utf8").trim();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const accounts = await (
    await fetch("https://api.cloudflare.com/client/v4/accounts", { headers })
  ).json();
  const accountTag: string = accounts.result[0].id;
  const query = `query($a: String!, $s: Time!, $e: Time!) { viewer { accounts(filter: { accountTag: $a }) {
    w: workersInvocationsAdaptive(limit: 50, filter: { datetime_geq: $s, datetime_leq: $e, scriptName: "${WORKER_SCRIPT}" }) { sum { requests cpuTimeUs } }
    d: durableObjectsPeriodicGroups(limit: 50, filter: { datetime_geq: $s, datetime_leq: $e }) { sum { cpuTime activeTime } dimensions { namespaceId } }
  } } }`;
  const namespaces = await (
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountTag}/workers/durable_objects/namespaces`,
      { headers },
    )
  ).json();
  const ours = new Map<string, string>(
    namespaces.result
      .filter((n: any) => n.script === WORKER_SCRIPT)
      .map((n: any) => [n.id, n.class]),
  );
  const lines = NodeFS.readFileSync(OUT, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const runs = lines.filter(
    (l) => l.side === "a" && l.startedAt !== undefined && l.mode !== "par-batch",
  );
  for (const [batch, rs] of Map.groupBy(runs, (r) => r.batch)) {
    // Periodic DO metrics roll up per minute, so widen the window to whole minutes.
    const s = new Date(Math.floor(Math.min(...rs.map((r) => r.startedAt)) / 60_000) * 60_000);
    const e = new Date(Math.ceil(Math.max(...rs.map((r) => r.endedAt)) / 60_000) * 60_000);
    const body = JSON.stringify({
      query,
      variables: { a: accountTag, s: s.toISOString(), e: e.toISOString() },
    });
    const data = await (
      await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers, body })
    ).json();
    if (data.errors) throw new Error(JSON.stringify(data.errors));
    const acct = data.data.viewer.accounts[0];
    const workerCpuS = acct.w.reduce((sum: number, g: any) => sum + g.sum.cpuTimeUs, 0) / 1e6;
    const doCpu: Record<string, number> = {};
    for (const g of acct.d) {
      const name = ours.get(g.dimensions.namespaceId);
      if (name !== undefined) doCpu[name] = (doCpu[name] ?? 0) + g.sum.cpuTime / 1e6;
    }
    const batchRecord = lines.find((l) => l.mode === "par-batch" && l.batch === batch);
    const foreign =
      batchRecord?.foreignSessions ?? rs.reduce((n, r) => n + (r.foreignSessions ?? 0), 0);
    const total = workerCpuS + Object.values(doCpu).reduce((x, y) => x + y, 0);
    console.log(
      `${batch} ${rs[0].task} ${rs[0].mode} ${s.toISOString()}..${e.toISOString()} sessions=${rs.length} foreign=${foreign} ` +
        `workerCpuS=${workerCpuS.toFixed(2)} do=${JSON.stringify(Object.fromEntries(Object.entries(doCpu).map(([k, v]) => [k, +v.toFixed(2)])))} ` +
        `cpuS/session=${(total / (rs.length + foreign)).toFixed(2)}`,
    );
  }
};

const [command, side, task, count, mode] = process.argv.slice(2);
if (command === "report") report(Number(side ?? "0"));
else if (command === "cloudflare") await cloudflare();
else if (
  command === "run" &&
  (side === "a" || side === "b") &&
  (task === "edit" || task === "survey")
) {
  await run(side, task, Number(count ?? "1"), mode === "par");
  process.exit(0);
} else {
  console.error("usage: node scripts/bench.ts run <a|b> <edit|survey> <count> [par] | report");
  process.exit(2);
}
