// Replays each task's recorded tool calls against the hc stack, whose Worker runs MODEL_PROVIDER=replay, so a run
// spends no model tokens and its wall time is the infrastructure's alone.
//
//   node scripts/hillclimb/replay.ts --runs N [--label name] [--tasks id,id]
//   node scripts/hillclimb/replay.ts report --label a,b

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { isFailed, spans, unionMs, type Span, type ToolName } from "./metrics.ts";
import { outcomeOf, type Plan } from "./plans.ts";
import { runSession } from "./session.ts";

const OUT_DIR = "/tmp/dorbs-hillclimb";
const OUT = `${OUT_DIR}/replay.jsonl`;
const FRAMES = `${OUT_DIR}/replay-frames`;
const PLANS = new URL("plans/", import.meta.url).pathname;
const SOCKET = "/tmp/dorbs-hc.sock";
const TURN_MS = 600_000;
/** The prefix the Worker's replay model reads a plan after; see apps/agent-worker/src/ReplayModel.ts. */
const REPLAY_PREFIX = "replay ";

const GROUPS = ["clone", "read", "write", "check", "test", "git", "gh"] as const;
type Group = (typeof GROUPS)[number];
const GROUP_OF: Partial<Record<ToolName, Group>> = {
  clone_repo: "clone",
  read_file: "read",
  list_files: "read",
  grep: "read",
  write_file: "write",
  edit_file: "write",
  check: "check",
  test: "test",
  git: "git",
  gh: "gh",
};

type Replay = {
  readonly label: string;
  readonly batch: string;
  readonly id: string;
  readonly task: string;
  readonly wallMs: number;
  readonly stopReason: string | undefined;
  readonly error: string | undefined;
  /** Plan calls, and calls the turn ran to an end; they differ when the work did not happen. */
  readonly planned: number;
  readonly ran: number;
  readonly failed: number;
  /** Calls whose outcome differs from the recording's. */
  readonly mismatches: number;
  /** Turn wall minus wall covered by tool calls: the DO, the mux, history and the replay model. */
  readonly overheadMs: number;
  readonly toolMs: Readonly<Partial<Record<Group, ReadonlyArray<number>>>>;
};

const median = (xs: ReadonlyArray<number>): number => {
  const s = xs.toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length === 0 ? NaN : s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const loadPlans = (wanted: ReadonlyArray<string> | undefined): Plan[] =>
  NodeFS.readdirSync(PLANS)
    .filter((f) => f.endsWith(".json"))
    .map((f): Plan => JSON.parse(NodeFS.readFileSync(`${PLANS}${f}`, "utf8")))
    .filter((p) => wanted === undefined || wanted.includes(p.task))
    .toSorted((a, b) => a.task.localeCompare(b.task));

const replayOnce = async (plan: Plan, label: string, batch: string): Promise<Replay> => {
  const id = NodeCrypto.randomBytes(3).toString("hex");
  const text = REPLAY_PREFIX + JSON.stringify(plan.rounds);
  const session = await runSession(SOCKET, `/tmp/dorbs-hillclimb-cwd/${id}`, [text], TURN_MS);
  NodeFS.writeFileSync(`${FRAMES}/${id}.json`, JSON.stringify(session));
  const turn = session.turns[0];
  const all: Span[] = turn === undefined ? [] : spans(turn.updates);
  const outcomes = all.map(outcomeOf);
  const toolMs: Partial<Record<Group, number[]>> = {};
  for (const span of all) {
    const group = GROUP_OF[span.tool];
    if (group !== undefined && Number.isFinite(span.endMs))
      (toolMs[group] ??= []).push(span.endMs - span.startMs);
  }
  const wallMs = turn?.wallMs ?? TURN_MS;
  return {
    label,
    batch,
    id,
    task: plan.task,
    wallMs,
    stopReason: turn?.stopReason,
    error: turn?.error ?? session.error,
    planned: plan.outcomes.length,
    ran: all.filter((s) => s.status !== "unfinished").length,
    failed: all.filter(isFailed).length,
    mismatches:
      Math.abs(outcomes.length - plan.outcomes.length) +
      outcomes.filter((o, i) => plan.outcomes[i] !== undefined && o !== plan.outcomes[i]).length,
    overheadMs: wallMs - unionMs(all),
    toolMs,
  };
};

/** A run that diverged from the recording scores the turn ceiling, so failing is never faster than succeeding. */
const doneMs = (r: Replay): number =>
  r.stopReason === "end_turn" && r.ran === r.planned && r.mismatches === 0 ? r.wallMs : TURN_MS;

const fmt = (ms: number) => (Number.isNaN(ms) ? "-" : (ms / 1000).toFixed(2));

const summary = (label: string, runs: ReadonlyArray<Replay>) => {
  const byTask = Map.groupBy(runs, (r) => r.task);
  const rows = [...byTask].map(([task, rs]) => ({
    task,
    wall: median(rs.map(doneMs)),
    range: `${fmt(Math.min(...rs.map((r) => r.wallMs)))}-${fmt(Math.max(...rs.map((r) => r.wallMs)))}`,
    overhead: median(rs.map((r) => r.overheadMs)),
    n: rs.length,
  }));
  const primary = median(rows.map((r) => r.wall));
  const errors = runs.filter((r) => doneMs(r) === TURN_MS).length;
  console.log(`\n## ${label}: ${runs.length} runs`);
  console.log("task\tn\twall s p50 (range)\toverhead s p50");
  for (const r of rows)
    console.log(`${r.task}\t${r.n}\t${fmt(r.wall)} (${r.range})\t${fmt(r.overhead)}`);
  const per = GROUPS.map((g) => {
    const xs = runs.flatMap((r) => r.toolMs[g] ?? []);
    return `${g} ${xs.length}x p50 ${fmt(median(xs))} s, sum/run ${fmt(xs.reduce((a, b) => a + b, 0) / runs.length)} s`;
  });
  console.log(`per call: ${per.join("; ")}`);
  console.log(
    `PRIMARY ${fmt(primary)} s | overhead/run p50 ${fmt(median(runs.map((r) => r.overheadMs)))} s | ` +
      `calls ran ${runs.reduce((n, r) => n + r.ran, 0)}/${runs.reduce((n, r) => n + r.planned, 0)} | ` +
      `failed ${runs.reduce((n, r) => n + r.failed, 0)} | mismatches ${runs.reduce((n, r) => n + r.mismatches, 0)} | ` +
      `errors ${errors}`,
  );
};

const main = async () => {
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      runs: { type: "string", default: "1" },
      label: { type: "string", default: "run" },
      tasks: { type: "string" },
    },
  });
  if (positionals[0] === "report") {
    const all: Replay[] = NodeFS.readFileSync(OUT, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    for (const label of values.label.split(",")) {
      summary(
        label,
        all.filter((r) => r.label === label),
      );
    }
    return;
  }
  const plans = loadPlans(values.tasks?.split(","));
  if (plans.length === 0) throw new Error(`no plans match ${values.tasks}`);
  NodeFS.mkdirSync(FRAMES, { recursive: true });
  const batch = NodeCrypto.randomBytes(3).toString("hex");
  const runs: Replay[] = [];
  for (let i = 0; i < Number(values.runs); i++) {
    for (const plan of plans) {
      const run = await replayOnce(plan, values.label, batch);
      NodeFS.appendFileSync(OUT, `${JSON.stringify(run)}\n`);
      runs.push(run);
      console.log(
        `${run.task} ${run.id}: ${fmt(run.wallMs)} s, overhead ${fmt(run.overheadMs)} s, ran ${run.ran}/${run.planned}, ` +
          `failed ${run.failed}, mismatches ${run.mismatches}${run.stopReason === "end_turn" ? "" : `, ${run.stopReason ?? run.error}`}`,
      );
    }
  }
  summary(`${values.label} (batch ${batch})`, runs);
};

await main();
