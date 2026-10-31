import { assert, it } from "@effect/vitest";

import { CommitSha } from "@dorbs/protocol/typecheck";

import { type EnvEvent, type EnvState, IllegalTransition, transition } from "./Environment.ts";

const A = CommitSha.make("a".repeat(40));
const B = CommitSha.make("b".repeat(40));

const run = (events: ReadonlyArray<EnvEvent>, from: EnvState = { _tag: "Absent" }) =>
  events.reduce(transition, from);

it("sets up, serves runs one at a time, idles and comes back", () => {
  const events: ReadonlyArray<EnvEvent> = [
    { _tag: "SetupStarted" },
    { _tag: "SetupSucceeded", tree: A, at: 1 },
    { _tag: "Acquired" },
    { _tag: "Released", tree: B, at: 2 },
    { _tag: "Stopped" },
    { _tag: "Started" },
  ];
  const states = events.map((_, index) => run(events.slice(0, index + 1)));
  assert.deepStrictEqual(states, [
    { _tag: "SettingUp" },
    { _tag: "Ready", tree: A, lastUsed: 1 },
    { _tag: "Busy", tree: A, lastUsed: 1 },
    { _tag: "Ready", tree: B, lastUsed: 2 },
    { _tag: "Idle", tree: B, lastUsed: 2 },
    { _tag: "Ready", tree: B, lastUsed: 2 },
  ]);
});

it("keeps a failed setup's output and sets up again on the next request", () => {
  const failed = run([
    { _tag: "SetupStarted" },
    { _tag: "SetupFailed", step: "install", output: "E404" },
  ]);
  assert.deepStrictEqual(failed, { _tag: "Failed", step: "install", output: "E404" });
  assert.deepStrictEqual(transition(failed, { _tag: "SetupStarted" }), { _tag: "SettingUp" });
});

it("evicts only an environment no run holds, and sets an evicted one up again", () => {
  const ready = run([{ _tag: "SetupStarted" }, { _tag: "SetupSucceeded", tree: A, at: 1 }]);
  const evicted = transition(ready, { _tag: "Evicted" });
  assert.deepStrictEqual(evicted, { _tag: "Evicted" });
  assert.deepStrictEqual(transition(evicted, { _tag: "SetupStarted" }), { _tag: "SettingUp" });
  const busy = transition(ready, { _tag: "Acquired" });
  assert.throws(() => transition(busy, { _tag: "Evicted" }), IllegalTransition);
  assert.throws(() => transition({ _tag: "SettingUp" }, { _tag: "Evicted" }), IllegalTransition);
});

it("refuses a second run while one holds the environment", () => {
  const busy = run([
    { _tag: "SetupStarted" },
    { _tag: "SetupSucceeded", tree: A, at: 1 },
    { _tag: "Acquired" },
  ]);
  assert.throws(() => transition(busy, { _tag: "Acquired" }), IllegalTransition);
  assert.throws(() => transition(busy, { _tag: "Stopped" }), IllegalTransition);
});
