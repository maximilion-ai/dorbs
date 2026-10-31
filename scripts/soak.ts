// Soak tests against the deployed agent through the cloud acp-mux socket; each mode prints TSV rows.
//   node scripts/soak.ts long 32 | idle-setup <label> | idle-check <label> | kill tool|stream
//   node scripts/soak.ts cancel tool|stream | conc 20

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { isCleanCheck } from "./checkerDouble.ts";
import { acpClient, prompt, T3_INITIALIZE_LINE } from "./stack.ts";

const SOCKET = process.env.SOAK_SOCKET ?? "/tmp/dorbs-cloud.sock";
const CWD = "/tmp/dorbs-cloud-project";
const REPO = "maximilionai/dorbs-sandbox";
const STATE = "/tmp/dorbs-soak";
const TURN_MS = 300_000;
const TURN_ENDED = "dorbs/turnEnded";

NodeFS.mkdirSync(CWD, { recursive: true });
NodeFS.mkdirSync(STATE, { recursive: true });

const now = () => performance.now();
const since = (t: number) => Math.round(now() - t);
const row = (...cells: ReadonlyArray<unknown>) => console.log(cells.join("\t"));

let nextId = 10;

const connect = async () => {
  const nc = NodeChildProcess.spawn("/usr/bin/nc", ["-U", SOCKET], {
    cwd: CWD,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = acpClient(nc);
  client.sendLine(T3_INITIALIZE_LINE);
  await client.next((f) => f.id === 1073741824, 60_000, "initialize");
  const close = () => {
    nc.stdin.end();
    nc.kill("SIGTERM");
  };
  return { nc, client, close };
};
type Conn = Awaited<ReturnType<typeof connect>>;

const newSession = async ({ client }: Conn): Promise<string> => {
  const created = await client.request(
    nextId++,
    "session/new",
    { cwd: CWD, mcpServers: [] },
    60_000,
  );
  if (created.result?.sessionId === undefined) throw new Error(JSON.stringify(created));
  return created.result.sessionId;
};

/** session/load on a connection: its wall time and the session/update frames replayed before the response. */
const load = async ({ client }: Conn, sessionId: string) => {
  const before = client.frames.length;
  const t = now();
  const id = nextId++;
  const answer = await client.request(
    id,
    "session/load",
    { sessionId, cwd: CWD, mcpServers: [] },
    120_000,
  );
  const ms = since(t);
  const at = client.frames.indexOf(answer);
  const replayed = client.frames
    .slice(before, at)
    .filter((f) => f.method === "session/update" && f.params?.sessionId === sessionId);
  return {
    ms,
    error: answer.error?.message,
    frames: replayed.length,
    bytes: replayed.reduce((sum, f) => sum + JSON.stringify(f).length + 1, 0),
    updates: replayed.map((f) => f.params.update),
  };
};

/** One prompt; resolves on the response. `onUpdate` sees each update of this turn as it arrives. */
const turn = async (conn: Conn, sessionId: string, text: string, onUpdate?: (u: any) => void) => {
  const { client, nc } = conn;
  const before = client.frames.length;
  const t = now();
  let firstUpdateMs: number | undefined;
  const watch = () => {
    firstUpdateMs ??= since(t);
  };
  nc.stdout.on("data", watch);
  let seen = before;
  const poll =
    onUpdate === undefined
      ? undefined
      : setInterval(() => {
          for (; seen < client.frames.length; seen++) {
            const f = client.frames[seen];
            if (f?.method === "session/update" && f.params?.sessionId === sessionId)
              onUpdate(f.params.update);
          }
        }, 20);
  try {
    const id = nextId++;
    const answer = await client.request(id, "session/prompt", prompt(sessionId, text), TURN_MS);
    const updates = client.frames
      .slice(before)
      .filter((f) => f.method === "session/update" && f.params?.sessionId === sessionId)
      .map((f) => f.params.update);
    const toolTitles = updates.filter((u) => u.sessionUpdate === "tool_call").map((u) => u.title);
    const toolResults = updates
      .filter((u) => u.sessionUpdate === "tool_call_update" && u.status !== undefined)
      .map((u) => `${u.status}:${JSON.stringify(u.content ?? []).slice(0, 200)}`);
    const reply = updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content?.text ?? "")
      .join("");
    return {
      ms: since(t),
      firstUpdateMs,
      stop: answer.result?.stopReason ?? `error: ${answer.error?.message}`,
      toolTitles,
      toolResults,
      reply,
    };
  } finally {
    nc.stdout.off("data", watch);
    if (poll !== undefined) clearInterval(poll);
  }
};

const saveState = (label: string, state: unknown) =>
  NodeFS.writeFileSync(`${STATE}/${label}.json`, JSON.stringify(state, null, 2));
const readState = (label: string) =>
  JSON.parse(NodeFS.readFileSync(`${STATE}/${label}.json`, "utf8"));

const fit = (xs: ReadonlyArray<number>, ys: ReadonlyArray<number>) => {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const sxy = xs.reduce((s, x, i) => s + (x - mx) * ((ys[i] ?? 0) - my), 0);
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const ssTot = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  const ssRes = ys.reduce((s, y, i) => s + (y - (intercept + slope * (xs[i] ?? 0))) ** 2, 0);
  return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
};

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

/** One thread of `count` turns, with a fresh nc and session/load after each to time the replay. */
const long = async (count: number) => {
  let conn = await connect();
  const sessionId = await newSession(conn);
  console.log(`# session ${sessionId}`);
  const prompts = (k: number): [string, string] => {
    if (k === 1) return ["clone", `Clone ${REPO} with clone_repo. Do nothing else. Reply: ok.`];
    const n = k - 1;
    switch (k % 4) {
      case 2:
        return [
          "write",
          `Use write_file once to create src/t${n}.ts containing exactly: export const t${n}: number = ${n};\nDo nothing else. Reply: ok.`,
        ];
      case 3:
        return [
          "edit",
          `Use edit_file once on src/t${n - 1}.ts to replace "= ${n - 1};" with "= ${n - 1}0;". Do nothing else. Reply: ok.`,
        ];
      case 0:
        return ["read", `Use read_file once on src/t${n - 2}.ts and reply with its content only.`];
      default:
        return ["typecheck", "Run the check tool once and reply with its output only."];
    }
  };
  row(
    "turn",
    "kind",
    "turn_ms",
    "first_update_ms",
    "stop",
    "tools",
    "load_ms",
    "replay_frames",
    "replay_bytes",
    "tool_result",
  );
  const rows: Array<{
    k: number;
    ms: number;
    loadMs: number;
    frames: number;
    bytes: number;
    tools: number;
  }> = [];
  for (let k = 1; k <= count; k++) {
    const [kind, text] = prompts(k);
    const r = await turn(conn, sessionId, text);
    conn.close();
    conn = await connect();
    const l = await load(conn, sessionId);
    rows.push({
      k,
      ms: r.ms,
      loadMs: l.ms,
      frames: l.frames,
      bytes: l.bytes,
      tools: r.toolTitles.length,
    });
    row(
      k,
      kind,
      r.ms,
      r.firstUpdateMs,
      r.stop,
      r.toolTitles.join("|") || "-",
      l.error ?? l.ms,
      l.frames,
      l.bytes,
      r.toolResults.at(-1)?.slice(0, 80) ?? r.reply.slice(0, 80).replace(/\s+/gu, " "),
    );
  }
  conn.close();
  const ks = rows.map((r) => r.k);
  const report = (name: string, ys: number[]) => {
    const f = fit(ks, ys);
    const half = Math.floor(ys.length / 2);
    const firstHalf = ys.slice(1, half);
    const secondHalf = ys.slice(half);
    const mean = (a: number[]) => Math.round(a.reduce((s, x) => s + x, 0) / Math.max(1, a.length));
    console.log(
      `# ${name}: slope ${f.slope.toFixed(2)}/turn intercept ${f.intercept.toFixed(0)} r2 ${f.r2.toFixed(3)}; ` +
        `mean turns 2..${half} ${mean(firstHalf)} vs ${half + 1}..${ys.length} ${mean(secondHalf)}`,
    );
  };
  report(
    "turn_ms",
    rows.map((r) => r.ms),
  );
  report(
    "load_ms",
    rows.map((r) => r.loadMs),
  );
  report(
    "replay_frames",
    rows.map((r) => r.frames),
  );
  report(
    "replay_bytes",
    rows.map((r) => r.bytes),
  );
  // Bytes per turn: if replay is linear, the increments stay flat.
  const inc = rows.slice(1).map((r, i) => r.bytes - (rows[i]?.bytes ?? 0));
  console.log(`# replay bytes added per turn: ${inc.join(",")}`);
};

/** Clones and writes a marker, then disconnects; `idleCheck` later loads the session and checks both. */
const idleSetup = async (label: string) => {
  const conn = await connect();
  const sessionId = await newSession(conn);
  const nonce = NodeCrypto.randomBytes(6).toString("hex");
  const r1 = await turn(
    conn,
    sessionId,
    `Clone ${REPO} with clone_repo. Do nothing else. Reply: ok.`,
  );
  const r2 = await turn(
    conn,
    sessionId,
    `Use write_file once to create src/marker.ts containing exactly: export const marker = "${nonce}";\nDo nothing else. Reply: ok.`,
  );
  const l = await load(conn, sessionId);
  conn.close();
  saveState(label, {
    sessionId,
    nonce,
    at: new Date().toISOString(),
    frames: l.frames,
    bytes: l.bytes,
  });
  row(
    "label",
    "session",
    "nonce",
    "clone_stop",
    "write_stop",
    "replay_frames",
    "replay_bytes",
    "at",
  );
  row(label, sessionId, nonce, r1.stop, r2.stop, l.frames, l.bytes, new Date().toISOString());
};

const idleCheck = async (label: string) => {
  const s = readState(label);
  const idleS = Math.round((Date.now() - Date.parse(s.at)) / 1000);
  const t = now();
  const conn = await connect();
  const connectMs = since(t);
  const l = await load(conn, s.sessionId);
  const transcriptOk =
    l.frames === s.frames && l.updates.some((u: any) => JSON.stringify(u).includes(s.nonce));
  const r = await turn(
    conn,
    s.sessionId,
    "Use read_file once on src/marker.ts and reply with its content only.",
  );
  const markerOk = r.toolResults.some((x) => x.includes(s.nonce));
  const tc = await turn(
    conn,
    s.sessionId,
    "Run the check tool once and reply with its output only.",
  );
  conn.close();
  row(
    "label",
    "idle_s",
    "connect_ms",
    "load_ms",
    "replay_frames(before)",
    "transcript_ok",
    "read_ms",
    "read_stop",
    "marker_ok",
    "typecheck_ms",
    "typecheck_result",
  );
  row(
    label,
    idleS,
    connectMs,
    l.error ?? l.ms,
    `${l.frames}(${s.frames})`,
    transcriptOk,
    r.ms,
    r.stop,
    markerOk,
    tc.ms,
    tc.toolResults.at(-1)?.slice(0, 80) ?? tc.stop,
  );
};

/** Kills nc mid-turn, reconnects and loads until the killed turn ends, then prompts again. */
const kill = async (where: "tool" | "stream") => {
  const conn = await connect();
  const sessionId = await newSession(conn);
  console.log(`# session ${sessionId}`);
  await turn(conn, sessionId, `Clone ${REPO} with clone_repo. Do nothing else. Reply: ok.`);
  const text =
    where === "tool"
      ? "Use write_file to create src/k1.ts, src/k2.ts and src/k3.ts, each exporting one const number, one call per file, then run the check tool, then reply: ok."
      : "Write a 400-word story about a lighthouse keeper. Use no tools.";
  const t = now();
  let killedAt: number | undefined;
  const pending = turn(conn, sessionId, text, (u) => {
    const trigger =
      where === "tool"
        ? u.sessionUpdate === "tool_call"
        : u.sessionUpdate === "agent_message_chunk";
    if (trigger && killedAt === undefined) {
      killedAt = since(t);
      conn.nc.kill("SIGKILL");
    }
  }).catch((e: unknown) => ({ error: String(e) }));
  await new Promise<void>((resolve) => conn.nc.once("exit", () => resolve()));
  void pending;
  // Reconnect at once and load: the killed turn's end arrives in the replay or live on the new connection.
  // The clone turn ended first; the killed turn's end is the second.
  const re = now();
  const conn2 = await connect();
  const l2 = await load(conn2, sessionId);
  const ends = () =>
    conn2.client.frames.filter(
      (f) =>
        f.params?.sessionId === sessionId && f.params?.update?._meta?.[TURN_ENDED] !== undefined,
    );
  const endedIn = ends().length >= 2 ? "replay" : "live";
  const endFrame = await conn2.client.next(
    (f) => ends().length >= 2 && f === ends()[1],
    300_000,
    "end of the killed turn",
  );
  const ended = endFrame.params.update;
  const endedMs = since(re);
  const last = {
    updates: conn2.client.frames
      .filter((f) => f.params?.sessionId === sessionId && f.method === "session/update")
      .map((f) => f.params.update),
  };
  const polls = endedIn;
  const next =
    where === "tool"
      ? await turn(conn2, sessionId, "Use list_files once and reply with the file list only.")
      : await turn(conn2, sessionId, "Reply with the single word: ready");
  conn2.close();
  const tools = (last?.updates ?? [])
    .filter((u: any) => u.sessionUpdate === "tool_call")
    .map((u: any) => u.title);
  row(
    "where",
    "killed_at_ms",
    "turn_end",
    "end_after_reconnect_ms",
    "end_seen_in",
    "replay_frames",
    "tools_in_history",
    "next_stop",
    "next_ms",
    "next_result",
  );
  row(
    where,
    killedAt,
    JSON.stringify(ended?._meta?.[TURN_ENDED] ?? null),
    endedMs,
    polls,
    l2.frames,
    tools.join("|"),
    next.stop,
    next.ms,
    (next.toolResults.at(-1) ?? next.reply).slice(0, 120).replace(/\s+/gu, " "),
  );
};

/** Sends session/cancel mid tool call or mid model stream, then prompts again. */
const cancel = async (where: "tool" | "stream") => {
  const conn = await connect();
  const sessionId = await newSession(conn);
  console.log(`# session ${sessionId}`);
  await turn(conn, sessionId, `Clone ${REPO} with clone_repo. Do nothing else. Reply: ok.`);
  const text =
    where === "tool"
      ? "Run the check tool, then use write_file to create src/c1.ts exporting const c1 = 1, then run check again, then reply: ok."
      : "Write a 600-word essay about rivers. Use no tools.";
  let cancelledAt: number | undefined;
  let toolStatusAtCancel = "";
  const t = now();
  const r = await turn(conn, sessionId, text, (u) => {
    const trigger =
      where === "tool"
        ? u.sessionUpdate === "tool_call"
        : u.sessionUpdate === "agent_message_chunk";
    if (trigger && cancelledAt === undefined) {
      cancelledAt = since(t);
      toolStatusAtCancel = u.status ?? u.sessionUpdate;
      conn.client.send({ method: "session/cancel", params: { sessionId } });
    }
  });
  const next = await turn(conn, sessionId, "Reply with the single word: ready");
  const l = await load(conn, sessionId);
  conn.close();
  const ends = l.updates
    .filter((u: any) => u._meta?.[TURN_ENDED] !== undefined)
    .map((u: any) => JSON.stringify(u._meta[TURN_ENDED]));
  row(
    "where",
    "cancel_at_ms",
    "status_at_cancel",
    "cancel_stop",
    "cancel_turn_ms",
    "tools_started",
    "tool_results",
    "reply_chars",
    "next_stop",
    "next_ms",
    "next_reply",
    "history_turn_ends",
  );
  row(
    where,
    cancelledAt,
    toolStatusAtCancel,
    r.stop,
    r.ms,
    r.toolTitles.join("|") || "-",
    r.toolResults.map((x) => x.split(":")[0]).join("|") || "-",
    r.reply.length,
    next.stop,
    next.ms,
    next.reply.trim().slice(0, 40),
    ends.join(" "),
  );
};

const typecheckPid = () => {
  const out = NodeChildProcess.spawnSync(
    "/usr/sbin/lsof",
    ["-nP", "-iTCP:8790", "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  );
  return Number(out.stdout.trim().split("\n")[0]);
};

/** `count` parallel sessions doing clone, edit and typecheck, with a ps sampler on the typecheck service. */
const conc = async (count: number) => {
  const pid = typecheckPid();
  const samples: Array<{ cpu: number; rss: number }> = [];
  const sampler = setInterval(() => {
    const out = NodeChildProcess.spawnSync("/bin/ps", ["-o", "%cpu=,rss=", "-p", String(pid)], {
      encoding: "utf8",
    });
    const [cpu, rss] = out.stdout.trim().split(/\s+/u).map(Number);
    if (cpu !== undefined && rss !== undefined && !Number.isNaN(rss)) samples.push({ cpu, rss });
  }, 500);
  const logBefore = NodeFS.readFileSync(
    `${process.env.HOME}/.config/dorbs/logs/typecheck.log`,
    "utf8",
  ).length;
  const startedAt = new Date().toISOString();
  const one = async (n: number) => {
    const t = now();
    let conn: Conn | undefined;
    try {
      conn = await connect();
      const sessionId = await newSession(conn);
      const r = await turn(
        conn,
        sessionId,
        `Clone ${REPO}. Use write_file to create src/load${n}.ts exporting function load${n}(xs: number[]): number that returns the sum. ` +
          "Run the check tool, fix any errors, then reply with one sentence. Do not commit or push.",
      );
      return {
        n,
        ms: since(t),
        stop: r.stop,
        tools: r.toolTitles.length,
        clean: r.toolResults.some((x) => x.startsWith("completed") && isCleanCheck(x)),
        failedTools: r.toolResults.filter((x) => x.startsWith("failed")),
        typecheckResults: r.toolResults.filter((_, i) => r.toolTitles[i] === "`check`"),
      };
    } catch (error) {
      return {
        n,
        ms: since(t),
        stop: error instanceof Error ? error.message : String(error),
        tools: 0,
        clean: false,
        failedTools: [],
        typecheckResults: [],
      };
    } finally {
      conn?.close();
    }
  };
  const results = await Promise.all(Array.from({ length: count }, (_, i) => one(i + 1)));
  clearInterval(sampler);
  const log = NodeFS.readFileSync(
    `${process.env.HOME}/.config/dorbs/logs/typecheck.log`,
    "utf8",
  ).slice(logBefore);
  const actions = [
    ...log.matchAll(
      /http\.span=(\d+)ms: Sent HTTP response \{ 'http\.method': 'POST', 'http\.url': '\/actions', 'http\.status': (\d+)/gu,
    ),
  ];
  const statuses = new Map<string, number>();
  for (const a of actions) statuses.set(a[2] ?? "?", (statuses.get(a[2] ?? "?") ?? 0) + 1);
  const spans = actions.map((a) => Number(a[1])).toSorted((a, b) => a - b);
  const answered = results.filter((r) => r.stop === "end_turn");
  const ms = answered.map((r) => r.ms).toSorted((a, b) => a - b);
  const cpus = samples.map((s) => s.cpu);
  const rss = samples.map((s) => s.rss);
  row(
    "sessions",
    "end_turn",
    "clean_typecheck",
    "errors",
    "p50_ms",
    "p90_ms",
    "max_ms",
    "tool_calls",
    "failed_tools",
    "tc_actions",
    "tc_status",
    "tc_span_p50",
    "tc_span_max",
    "tc_cpu_max%",
    "tc_rss_kb_min..max",
    "samples",
    "started",
  );
  row(
    count,
    answered.length,
    results.filter((r) => r.clean).length,
    count - answered.length,
    percentile(ms, 50),
    percentile(ms, 90),
    ms.at(-1) ?? 0,
    results.reduce((s, r) => s + r.tools, 0),
    results.reduce((s, r) => s + r.failedTools.length, 0),
    actions.length,
    [...statuses].map(([k, v]) => `${k}x${v}`).join(","),
    percentile(spans, 50),
    spans.at(-1) ?? 0,
    Math.max(0, ...cpus),
    `${Math.min(...rss)}..${Math.max(...rss)}`,
    samples.length,
    startedAt,
  );
  for (const r of results.filter(
    (x) => x.stop !== "end_turn" || x.failedTools.length > 0 || !x.clean,
  )) {
    console.log(
      `# #${r.n} ${r.ms}ms stop=${r.stop} tools=${r.tools} failed=${JSON.stringify(r.failedTools).slice(0, 300)} tc=${JSON.stringify(r.typecheckResults).slice(0, 300)}`,
    );
  }
  const errLines = log.split("\n").filter((l) => /ERROR|WARN/u.test(l));
  if (errLines.length > 0)
    console.log(
      `# typecheck log WARN/ERROR lines: ${errLines.length}\n${errLines.slice(0, 10).join("\n")}`,
    );
};

const [mode, arg] = process.argv.slice(2);
switch (mode) {
  case "long":
    await long(Number(arg ?? "32"));
    break;
  case "idle-setup":
    await idleSetup(arg ?? "idle");
    break;
  case "idle-check":
    await idleCheck(arg ?? "idle");
    break;
  case "kill":
    await kill(arg === "stream" ? "stream" : "tool");
    break;
  case "cancel":
    await cancel(arg === "stream" ? "stream" : "tool");
    break;
  case "conc":
    await conc(Number(arg ?? "20"));
    break;
  default:
    console.error("usage: node scripts/soak.ts long|idle-setup|idle-check|kill|cancel|conc [arg]");
    process.exitCode = 2;
}
process.exit();
