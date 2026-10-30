import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";

// A failed run leaves no entry, so the next caller with that key runs it again.
type State<A, E> =
  | { readonly _tag: "Running"; readonly done: Deferred.Deferred<A, E> }
  | { readonly _tag: "Ready"; readonly value: A };

/**
 * Runs work once per key. Concurrent callers share the run in flight and later callers get its
 * value, for the `keep` keys that settled last. Runs fork into the scope that made the function,
 * so a caller hanging up cancels nothing.
 */
export const make = <A, E>(keep: number) =>
  Effect.all([Effect.scope, Ref.make(new Map<string, State<A, E>>())]).pipe(
    Effect.map(([scope, states]) => {
      const settle = (key: string, exit: Exit.Exit<A, E>) =>
        Ref.update(states, (map) => {
          const next = new Map(map);
          next.delete(key);
          if (Exit.isSuccess(exit) && keep > 0) {
            next.set(key, { _tag: "Ready", value: exit.value });
            const ready = [...next].filter(([, state]) => state._tag === "Ready");
            for (const [old] of ready.slice(0, Math.max(0, ready.length - keep))) next.delete(old);
          }
          return next;
        });

      return Effect.fn("SingleFlight.run")(function* (key: string, work: Effect.Effect<A, E>) {
        const done = yield* Deferred.make<A, E>();
        const existing = yield* Ref.modify(states, (map) => {
          const state = map.get(key);
          if (state) return [state, map];
          return [undefined, new Map(map).set(key, { _tag: "Running", done })];
        });
        if (existing?._tag === "Ready") return existing.value;
        if (existing?._tag === "Running") return yield* Deferred.await(existing.done);
        yield* work.pipe(
          Effect.onExit((exit) =>
            settle(key, exit).pipe(Effect.andThen(Deferred.done(done, exit))),
          ),
          Effect.forkIn(scope),
        );
        return yield* Deferred.await(done);
      });
    }),
  );
