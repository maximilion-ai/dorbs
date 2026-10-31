// What one run measured, derived from its turns' stamped session/update frames, and whether the task got done.

import type { Stamped, TurnRecord } from "./session.ts";
import type { Task } from "./tasks.ts";

export type ToolName =
  | "clone_repo"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "list_files"
  | "grep"
  | "check"
  | "test"
  | "git"
  | "gh"
  | "other";

export type Span = {
  readonly tool: ToolName;
  readonly title: string;
  readonly startMs: number;
  /** NaN when the turn ended before the call did. */
  readonly endMs: number;
  readonly status: "completed" | "failed" | "unfinished";
  readonly text: string;
};

/** The tool behind a call's title; execute tools show a backticked command line. */
const toolOf = (title: string): ToolName => {
  const line = title.replaceAll("`", "");
  if (line.startsWith("git clone ")) return "clone_repo";
  const first = line.split(" ")[0] ?? "";
  const known: ReadonlyArray<ToolName> = [
    "read_file",
    "write_file",
    "edit_file",
    "list_files",
    "grep",
    "check",
    "test",
    "git",
    "gh",
  ];
  return known.find((name) => name === first) ?? "other";
};

export const spans = (updates: ReadonlyArray<Stamped>): Span[] => {
  const open = new Map<string, { title: string; at: number }>();
  const done: Span[] = [];
  for (const { at, update } of updates) {
    if (update.sessionUpdate === "tool_call") {
      open.set(update.toolCallId, { title: String(update.title ?? ""), at });
    } else if (
      update.sessionUpdate === "tool_call_update" &&
      (update.status === "completed" || update.status === "failed")
    ) {
      const start = open.get(update.toolCallId);
      if (start === undefined) continue;
      open.delete(update.toolCallId);
      const text = (update.content ?? [])
        .map((item: any) => (item.type === "content" ? (item.content?.text ?? "") : ""))
        .join("\n");
      done.push({
        tool: toolOf(start.title),
        title: start.title,
        startMs: start.at,
        endMs: at,
        status: update.status,
        text,
      });
    }
  }
  for (const { title, at } of open.values()) {
    done.push({
      tool: toolOf(title),
      title,
      startMs: at,
      endMs: NaN,
      status: "unfinished",
      text: "",
    });
  }
  return done.toSorted((a, b) => a.startMs - b.startMs);
};

/**
 * Agent friction: a tool result that shows the agent misused or misunderstood a tool. Each rule names a tool
 * (or any) and a pattern over the result text; a call counts once, under the first rule that matches.
 */
const FRICTION_RULES: ReadonlyArray<{
  readonly id: string;
  readonly tools: ReadonlyArray<ToolName> | "any";
  readonly pattern: RegExp;
}> = [
  {
    id: "missing-path",
    tools: ["read_file", "edit_file", "list_files", "grep"],
    pattern: /no such file|ENOENT|not a directory|is a directory/iu,
  },
  {
    id: "bad-path",
    tools: "any",
    pattern: /RelativePath|not a path inside the repo|goes through a symbolic link|git directory/u,
  },
  { id: "edit-mismatch", tools: ["edit_file"], pattern: /oldText must occur exactly once/u },
  {
    id: "bad-arguments",
    tools: "any",
    pattern:
      /Validation failed|must have required property|must NOT have additional properties|takes an object of arguments|Expected .* but received/iu,
  },
  { id: "unknown-tool", tools: "any", pattern: /Tool .{0,60} not found|unknown tool/iu },
  {
    id: "unsupported-command",
    tools: ["git", "gh"],
    pattern:
      /is not available|is not supported|not supported\.|does not take|Supported commands|global options such as|unknown option|unknown switch|is not a git command/iu,
  },
  {
    id: "shell-syntax",
    tools: ["git", "gh"],
    pattern: /shell operator|backtick|\$\(|refused rather than/iu,
  },
  { id: "wrong-repo", tools: ["clone_repo"], pattern: /is not a registered repo|already holds/u },
  { id: "tool-order", tools: "any", pattern: /No repo is cloned|Call clone_repo first/u },
  { id: "unknown-check", tools: ["check"], pattern: /this repo has no check/u },
  {
    id: "test-selection",
    tools: ["test"],
    pattern:
      /takes no name filter|takes a name filter, not files|where the tests run|in no workspace package|Pass the test files/u,
  },
];

/** Failures outside the agent's control: the checker, the network, GitHub. */
const INFRA =
  /setting up the repo's environment failed|cannot fetch commit|origin answered HTTP|fetch failed|ECONNRESET|ETIMEDOUT|\b50[234]\b|timed out/iu;

const frictionOf = (span: Span): string | undefined =>
  FRICTION_RULES.find(
    (rule) =>
      (rule.tools === "any" || rule.tools.includes(span.tool)) && rule.pattern.test(span.text),
  )?.id;

/** A call that did not do what it was asked: a failed status, a nonzero git or gh exit, or a refusal. */
export const isFailed = (span: Span): boolean =>
  span.status !== "completed" ||
  /\nexit [1-9]\d*$|^exit [1-9]\d*$/u.test(span.text) ||
  /^Not (checked|run):|^No repo is cloned/u.test(span.text);

/** A check call is green when every check it ran passed. */
const checkGreen = (span: Span): boolean =>
  span.status === "completed" &&
  / passed: /u.test(span.text) &&
  !/^\S+ (failed|timed out)/mu.test(span.text) &&
  !span.text.startsWith("Not checked");

/** The passing test count of a green test call; 0 when red or when no test ran. */
const testsPassed = (span: Span): number => {
  const match = /^Tests passed: (\d+) passed/u.exec(span.text);
  return span.status === "completed" && match !== null ? Number(match[1]) : 0;
};

export const isGreen = (span: Span): boolean =>
  span.tool === "check" ? checkGreen(span) : span.tool === "test" ? testsPassed(span) > 0 : false;

const isWrite = (span: Span): boolean =>
  (span.tool === "write_file" || span.tool === "edit_file") && span.status === "completed";

const lastWriteMs = (xs: ReadonlyArray<Span>): number =>
  Math.max(-Infinity, ...xs.filter(isWrite).map((s) => s.endMs));

/** Wall time covered by at least one span. */
export const unionMs = (xs: ReadonlyArray<Span>): number => {
  let covered = 0;
  let end = -Infinity;
  for (const span of xs
    .filter((s) => Number.isFinite(s.endMs))
    .toSorted((a, b) => a.startMs - b.startMs)) {
    if (span.endMs <= end) continue;
    covered += span.endMs - Math.max(span.startMs, end);
    end = span.endMs;
  }
  return covered;
};

/** Model rounds: one starts with the first frame after every open tool call has ended. */
const modelCalls = (updates: ReadonlyArray<Stamped>): number => {
  let calls = 0;
  let inModel = false;
  const open = new Set<string>();
  for (const { update } of updates) {
    const kind = update.sessionUpdate;
    if (kind === "tool_call") {
      if (!inModel && open.size === 0) calls += 1;
      inModel = false;
      open.add(update.toolCallId);
    } else if (
      kind === "tool_call_update" &&
      (update.status === "completed" || update.status === "failed")
    ) {
      open.delete(update.toolCallId);
    } else if (
      (kind === "agent_message_chunk" || kind === "agent_thought_chunk") &&
      !inModel &&
      open.size === 0
    ) {
      calls += 1;
      inModel = true;
    }
  }
  return calls;
};

export const LIMITERS = ["model", "check", "clone", "tools"] as const;
export type Limiter = (typeof LIMITERS)[number];

export type Metrics = {
  readonly wallMs: number;
  /** When the first green check or test that started after the turn's last write ended. */
  readonly firstGreenMs: number | undefined;
  readonly toolCalls: number;
  readonly failedToolCalls: number;
  readonly checkMs: ReadonlyArray<number>;
  readonly testMs: ReadonlyArray<number>;
  readonly cloneMs: number;
  readonly writes: number;
  readonly modelCalls: number;
  readonly friction: Readonly<Record<string, number>>;
  readonly frictionCount: number;
  readonly infraErrors: number;
  /** Wall time split into what bounds it; tool shares are wall time covered by calls of that group. */
  readonly split: Readonly<Record<Limiter, number>>;
  readonly limiter: Limiter;
};

export const metrics = (turn: TurnRecord): Metrics => {
  const all = spans(turn.updates);
  const duration = (s: Span) => s.endMs - s.startMs;
  const friction: Record<string, number> = {};
  for (const span of all) {
    const id = frictionOf(span);
    if (id !== undefined) friction[id] = (friction[id] ?? 0) + 1;
  }
  const verify = all.filter((s) => s.tool === "check" || s.tool === "test");
  const clone = all.filter((s) => s.tool === "clone_repo");
  const other = all.filter((s) => !verify.includes(s) && !clone.includes(s));
  const toolsMs = unionMs(all);
  const split: Record<Limiter, number> = {
    model: Math.max(0, turn.wallMs - toolsMs),
    check: unionMs(verify),
    clone: unionMs(clone),
    tools: unionMs(other),
  };
  const limiter = LIMITERS.reduce((a, b) => (split[b] > split[a] ? b : a));
  const lastWrite = lastWriteMs(all);
  const firstGreen = verify.find((s) => isGreen(s) && s.startMs >= lastWrite);
  return {
    wallMs: turn.wallMs,
    firstGreenMs: firstGreen?.endMs,
    toolCalls: all.length,
    failedToolCalls: all.filter(isFailed).length,
    checkMs: all.filter((s) => s.tool === "check").map(duration),
    testMs: all.filter((s) => s.tool === "test").map(duration),
    cloneMs: clone.reduce((sum, s) => sum + duration(s), 0),
    writes: all.filter(isWrite).length,
    modelCalls: modelCalls(turn.updates),
    friction,
    frictionCount: Object.values(friction).reduce((a, b) => a + b, 0),
    infraErrors: all.filter((s) => INFRA.test(s.text) && isFailed(s)).length,
    split,
    limiter,
  };
};

export const replyOf = (turn: TurnRecord): string =>
  turn.updates
    .filter(({ update }) => update.sessionUpdate === "agent_message_chunk")
    .map(({ update }) => update.content?.text ?? "")
    .join("");

/** The follow-up turn that reads back what the task turn left in the workspace. */
export const probeText = (task: Task): string => {
  const calls = [
    ...task.expect.files.map((f) => `read_file with path ${f.path}`),
    ...(task.expect.commit
      ? [
          "git with args `branch --show-current`",
          "git with args `status --porcelain`",
          "git with args `log --format=%H -n 1`",
        ]
      : []),
  ];
  return (
    "Verification step. Do not write, edit, commit or push anything. Make exactly these tool calls and no " +
    `others:\n${calls.map((c) => `- ${c}`).join("\n")}\nThen reply with one word: verified.`
  );
};

export const needsProbe = (task: Task): boolean =>
  task.expect.files.length > 0 || task.expect.commit;

export type Verdict = {
  readonly success: boolean;
  /** False when the clone reported another commit than the task's base: the run measured another workload. */
  readonly valid: boolean;
  readonly failures: ReadonlyArray<string>;
};

const gitOutput = (probe: ReadonlyArray<Span>, args: string): string | undefined =>
  probe.find(
    (s) =>
      s.tool === "git" && s.title.replaceAll("`", "") === `git ${args}` && s.status === "completed",
  )?.text;

/** Whether the task got done, from the task turn, the probe turn, and whether origin gained the run's branch. */
export const verdict = (
  task: Task,
  branch: string,
  turn: TurnRecord | undefined,
  probe: TurnRecord | undefined,
  remoteBranch: boolean,
): Verdict => {
  if (turn === undefined) return { success: false, valid: true, failures: ["no turn"] };
  const failures: string[] = [];
  const all = spans(turn.updates);
  const cloned = all.find((s) => s.tool === "clone_repo" && s.status === "completed");
  const valid = cloned === undefined || cloned.text.includes(task.base);
  if (turn.stopReason !== "end_turn")
    failures.push(`stop ${turn.stopReason ?? turn.error ?? "none"}`);
  if (cloned === undefined) failures.push("never cloned");
  const lastWrite = lastWriteMs(all);
  for (const tool of task.expect.verified) {
    const last = all.filter((s) => s.tool === tool).at(-1);
    if (last === undefined) failures.push(`no ${tool}`);
    else if (!isGreen(last)) failures.push(`last ${tool} red`);
    else if (last.startMs < lastWrite) failures.push(`last ${tool} before last write`);
    else if (tool === "test" && testsPassed(last) < task.expect.minTests)
      failures.push(`${testsPassed(last)} tests < ${task.expect.minTests}`);
  }
  if (task.expect.readOnly && all.some(isWrite)) failures.push("wrote files");
  const reply = replyOf(turn);
  for (const pattern of task.expect.reply)
    if (!pattern.test(reply)) failures.push(`reply lacks ${pattern.source}`);
  const probeSpans = probe === undefined ? [] : spans(probe.updates);
  if (needsProbe(task) && probe?.stopReason !== "end_turn") failures.push("probe failed");
  for (const file of task.expect.files) {
    const read = probeSpans.find(
      (s) =>
        s.tool === "read_file" && s.title === `read_file ${file.path}` && s.status === "completed",
    );
    if (read === undefined) failures.push(`missing ${file.path}`);
    else
      for (const pattern of file.matches)
        if (!pattern.test(read.text)) failures.push(`${file.path} lacks ${pattern.source}`);
  }
  if (task.expect.commit) {
    const current = gitOutput(probeSpans, "branch --show-current")?.trim();
    const status = gitOutput(probeSpans, "status --porcelain")?.trim();
    const head = gitOutput(probeSpans, "log --format=%H -n 1")?.trim();
    if (current !== branch) failures.push(`on branch ${current ?? "?"}`);
    if (status !== "(no output)" && status !== "") failures.push("uncommitted changes");
    if (head === undefined || head.startsWith(task.base)) failures.push("no commit");
  }
  const pushes = [...all, ...probeSpans].filter((s) => /^`(git push|gh pr create)/u.test(s.title));
  if (pushes.length > 0) failures.push("tried to push or open a PR");
  if (remoteBranch) failures.push("origin has the run's branch");
  return { success: failures.length === 0, valid, failures };
};
