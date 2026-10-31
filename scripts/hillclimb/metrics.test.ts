import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { metrics, verdict } from "./metrics.ts";
import type { Stamped, TurnRecord } from "./session.ts";
import { SANDBOX_TASKS } from "./tasks.ts";

const sum = SANDBOX_TASKS.find((t) => t.id === "sb-sum");
if (sum === undefined) throw new Error("sb-sum is missing");
const BRANCH = "dorbs/hc-sb-sum-abc123";

let ids = 0;
/** A tool call that starts at `at`, takes `ms`, and ends with `text`. */
const call = (
  at: number,
  ms: number,
  title: string,
  text: string,
  status = "completed",
): Stamped[] => {
  const toolCallId = `call_${(ids += 1)}`;
  return [
    { at, update: { sessionUpdate: "tool_call", toolCallId, title, status: "in_progress" } },
    {
      at: at + ms,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status,
        content: [{ type: "content", content: { type: "text", text } }],
      },
    },
  ];
};
const say = (at: number, text: string): Stamped => ({
  at,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const turn = (wallMs: number, updates: Stamped[]): TurnRecord => ({
  text: "",
  wallMs,
  stopReason: "end_turn",
  error: undefined,
  updates,
});

const CLONE = call(
  1000,
  1000,
  "`git clone maximilionai/dorbs-sandbox`",
  `Cloned maximilionai/dorbs-sandbox at ${sum.base} into the workspace root.`,
);
const GREEN_CHECK = (at: number) =>
  call(
    at,
    1500,
    "`check`",
    "typecheck passed: node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false",
  );
const GREEN_TEST = (at: number) =>
  call(at, 800, "`test`", "Tests passed: 3 passed, 0 failed, 0 skipped.\n$ node --test");
const WRITE = (at: number) => call(at, 10, "write_file src/sum.ts", "Created src/sum.ts");

const probe = turn(3000, [
  ...call(
    100,
    10,
    "read_file src/sum.ts",
    "export function sum(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0);\n}\n",
  ),
  ...call(100, 10, "read_file src/sum.test.ts", "import { test } from 'node:test';\n"),
  ...call(200, 10, "`git branch --show-current`", BRANCH),
  ...call(200, 10, "`git status --porcelain`", "(no output)"),
  ...call(200, 10, "`git log --format=%H -n 1`", "1111111111111111111111111111111111111111"),
]);

await NodeTest.test(
  "a turn that writes, then checks and tests green, then commits, succeeds",
  () => {
    const t = turn(20_000, [
      say(500, "Cloning."),
      ...CLONE,
      ...WRITE(3000),
      ...GREEN_CHECK(4000),
      ...GREEN_TEST(6000),
      say(8000, "Done."),
    ]);
    NodeAssert.deepEqual(verdict(sum, BRANCH, t, probe, false), {
      success: true,
      valid: true,
      failures: [],
    });
    const m = metrics(t);
    NodeAssert.deepEqual(
      {
        firstGreenMs: m.firstGreenMs,
        toolCalls: m.toolCalls,
        checkMs: m.checkMs,
        testMs: m.testMs,
        modelCalls: m.modelCalls,
        limiter: m.limiter,
      },
      {
        firstGreenMs: 5500,
        toolCalls: 4,
        checkMs: [1500],
        testMs: [800],
        modelCalls: 5,
        limiter: "model",
      },
    );
  },
);

await NodeTest.test(
  "a check before the last write, or a test run of zero tests, does not verify the turn",
  () => {
    const t = turn(20_000, [
      ...CLONE,
      ...GREEN_CHECK(3000),
      ...call(5000, 300, "`test`", "Tests passed: 0 passed, 0 failed, 0 skipped.\n$ node --test"),
      ...WRITE(6000),
    ]);
    NodeAssert.deepEqual(verdict(sum, BRANCH, t, probe, false).failures, [
      "last check before last write",
      "last test red",
    ]);
  },
);

await NodeTest.test("a clone of another commit marks the run invalid", () => {
  const moved = call(
    1000,
    1000,
    "`git clone maximilionai/dorbs-sandbox`",
    "Cloned maximilionai/dorbs-sandbox at 2222222 into the workspace root.",
  );
  NodeAssert.equal(
    verdict(
      sum,
      BRANCH,
      turn(9000, [...moved, ...WRITE(3000), ...GREEN_CHECK(4000), ...GREEN_TEST(6000)]),
      probe,
      false,
    ).valid,
    false,
  );
});

await NodeTest.test("a push attempt or a branch on origin fails the run", () => {
  const t = turn(20_000, [
    ...CLONE,
    ...WRITE(3000),
    ...GREEN_CHECK(4000),
    ...GREEN_TEST(6000),
    ...call(9000, 900, "`git push -u origin dorbs/x`", "Pushed dorbs/x to origin at 1111111"),
  ]);
  NodeAssert.deepEqual(verdict(sum, BRANCH, t, probe, true).failures, [
    "tried to push or open a PR",
    "origin has the run's branch",
  ]);
});

await NodeTest.test("friction counts misused tools by rule and leaves red checks alone", () => {
  const t = turn(20_000, [
    ...CLONE,
    ...call(
      2000,
      5,
      "read_file src/missing.ts",
      "<harness>\n[error] no such file: /workspace/src/missing.ts\n</harness>",
      "failed",
    ),
    ...call(
      2100,
      5,
      "`git push --dry-run`",
      "git push does not take --dry-run here. Push with git push.\nexit 1",
    ),
    ...call(2200, 5, "edit_file src/a.ts", "oldText must occur exactly once in src/a.ts", "failed"),
    ...call(
      2300,
      900,
      "`check`",
      "typecheck failed (exit 2): tsc\nsrc/a.ts:1:7 error TS2322 Type 'string' is not assignable to type 'number'. (tsc)",
    ),
  ]);
  const m = metrics(t);
  NodeAssert.deepEqual(
    { friction: m.friction, frictionCount: m.frictionCount, failedToolCalls: m.failedToolCalls },
    {
      friction: { "missing-path": 1, "unsupported-command": 1, "edit-mismatch": 1 },
      frictionCount: 3,
      failedToolCalls: 3,
    },
  );
});
