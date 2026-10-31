// Extracts each task's replay plan, the tool calls of one successful recorded run in order, from its frames.
//
//   node scripts/hillclimb/plans.ts --batch 9060db

import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { isFailed, isGreen, spans, type Span } from "./metrics.ts";
import type { SessionRecord, Stamped } from "./session.ts";

const OUT_DIR = "/tmp/dorbs-hillclimb";
const PLANS = new URL("plans/", import.meta.url).pathname;
/** Calls one model message makes start together; the next round starts a model response later. */
const SAME_ROUND_MS = 150;

type Call = { readonly name: string; readonly args: Record<string, unknown> };
/** What a call came to: check and test are green or red, any other call ok or failed. */
type Outcome = "ok" | "failed" | "green" | "red";
export type Plan = {
  readonly task: string;
  readonly runId: string;
  readonly recordedWallMs: number;
  readonly rounds: ReadonlyArray<ReadonlyArray<Call>>;
  /** Each call's recorded outcome, in start order; a replay that differs got other results from the infra. */
  readonly outcomes: ReadonlyArray<Outcome>;
};

export const outcomeOf = (span: Span): Outcome =>
  span.tool === "check" || span.tool === "test"
    ? isGreen(span)
      ? "green"
      : "red"
    : isFailed(span)
      ? "failed"
      : "ok";

/** The tool a call's title names; clone_repo shows as `git clone <repo>`, git and gh as their command line. */
const nameOf = (title: string): string => {
  const line = title.replaceAll("`", "");
  return line.startsWith("git clone ") ? "clone_repo" : (line.split(" ")[0] ?? "");
};

const roundsOf = (updates: ReadonlyArray<Stamped>): Call[][] => {
  const rounds: Call[][] = [];
  let lastStart = -Infinity;
  let spoke = false;
  for (const { at, update } of updates) {
    if (update.sessionUpdate === "agent_message_chunk") spoke = true;
    if (update.sessionUpdate !== "tool_call") continue;
    const call = { name: nameOf(String(update.title ?? "")), args: update.rawInput ?? {} };
    if (!spoke && at - lastStart < SAME_ROUND_MS && rounds.length > 0) rounds.at(-1)!.push(call);
    else rounds.push([call]);
    lastStart = at;
    spoke = false;
  }
  return rounds;
};

const main = () => {
  const { values } = NodeUtil.parseArgs({ options: { batch: { type: "string" } } });
  if (values.batch === undefined) throw new Error("--batch is required");
  const runs = NodeFS.readFileSync(`${OUT_DIR}/runs.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((r) => r.batch === values.batch && r.verdict.success === true);
  const byTask = Map.groupBy(runs, (r): string => r.task);
  NodeFS.mkdirSync(PLANS, { recursive: true });
  for (const [task, taskRuns] of byTask) {
    // The median run by wall time, so the plan is a typical path rather than the luckiest one.
    const sorted = taskRuns.toSorted((a, b) => a.metrics.wallMs - b.metrics.wallMs);
    const run = sorted[Math.floor((sorted.length - 1) / 2)];
    const session: SessionRecord = JSON.parse(
      NodeFS.readFileSync(`${OUT_DIR}/frames/${run.runId}.json`, "utf8"),
    );
    const updates = session.turns[0]!.updates;
    const rounds = roundsOf(updates);
    const outcomes = spans(updates).map(outcomeOf);
    const plan: Plan = {
      task,
      runId: run.runId,
      recordedWallMs: run.metrics.wallMs,
      rounds,
      outcomes,
    };
    NodeFS.writeFileSync(`${PLANS}${task}.json`, `${JSON.stringify(plan, null, 2)}\n`);
    const calls = rounds.reduce((n, r) => n + r.length, 0);
    console.log(
      `${task}: run ${run.runId}, ${calls} calls in ${rounds.length} rounds (recorded ${run.metrics.toolCalls} calls, ${run.metrics.modelCalls} model calls)`,
    );
  }
};

if (import.meta.main) main();
