import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as SingleFlight from "./SingleFlight.ts";

it.effect("keeps the values of the keys used last, and reruns one that is no longer valid", () =>
  Effect.gen(function* () {
    const runs: Array<string> = [];
    const gone = new Set<string>();
    const once = yield* SingleFlight.make<string, never>({
      keep: 2,
      valid: (value) => Effect.succeed(!gone.has(value)),
    });
    const run = (key: string) =>
      once(
        key,
        Effect.sync(() => {
          runs.push(key);
          return key;
        }),
      );
    yield* run("a");
    yield* run("b");
    yield* run("a");
    yield* run("c");
    // b settled before a was used again, so it is the one dropped.
    yield* run("a");
    yield* run("b");
    // a is still kept, but its value no longer holds.
    gone.add("a");
    yield* run("a");
    assert.deepStrictEqual(runs, ["a", "b", "c", "b", "a"]);
  }).pipe(Effect.scoped),
);

it.effect("runs a key again after its run failed", () =>
  Effect.gen(function* () {
    let calls = 0;
    const once = yield* SingleFlight.make<number, string>({ keep: 2 });
    const work = Effect.suspend(() => {
      calls += 1;
      return calls === 1 ? Effect.fail("first") : Effect.succeed(calls);
    });
    const first = yield* once("k", work).pipe(Effect.flip);
    assert.deepStrictEqual(
      [first, yield* once("k", work), yield* once("k", work)],
      ["first", 2, 2],
    );
  }).pipe(Effect.scoped),
);
