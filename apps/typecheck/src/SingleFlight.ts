import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";

// A failed run leaves no entry, so the next caller with that key runs it again.
type State<A, E> =
  | { readonly _tag: "Running"; readonly done: Deferred.Deferred<A, E> }
  | { readonly _tag: "Ready"; readonly value: A };

export type Options<A> = {
  /** How many settled values to keep, for the keys used last. */
  readonly keep: number;
  /** Whether a kept value still holds, such as a directory that eviction may have removed. */
  readonly valid?: (value: A) => Effect.Effect<boolean>;
};

/**
 * Runs work once per key. Concurrent callers share the run in flight and later callers get its
 * value while it is kept and valid. Runs fork into the scope that made the function, so a caller
 * hanging up cancels nothing.
 */
export const make = <A, E>(options: Options<A>) =>
  Effect.all([Effect.scope, Ref.make(new Map<string, State<A, E>>())]).pipe(
    Effect.map(([scope, states]) => {
      // Map order is use order: a key moves to the end when settled or used.
      const settle = (key: string, exit: Exit.Exit<A, E>) =>
        Ref.update(states, (map) => {
          const next = new Map(map);
          next.delete(key);
          if (Exit.isSuccess(exit) && options.keep > 0) {
            next.set(key, { _tag: "Ready", value: exit.value });
            const ready = [...next].filter(([, state]) => state._tag === "Ready");
            for (const [old] of ready.slice(0, ready.length - options.keep)) next.delete(old);
          }
          return next;
        });

      const run = Effect.fn("SingleFlight.run")(function* (
        key: string,
        work: Effect.Effect<A, E>,
      ): Effect.fn.Return<A, E> {
        const done = yield* Deferred.make<A, E>();
        const existing = yield* Ref.modify(states, (map) => {
          const state = map.get(key);
          if (state === undefined) {
            return [undefined, new Map(map).set(key, { _tag: "Running", done })];
          }
          const next = new Map(map);
          next.delete(key);
          return [state, next.set(key, state)];
        });
        if (existing?._tag === "Running") return yield* Deferred.await(existing.done);
        if (existing?._tag === "Ready") {
          if (options.valid === undefined || (yield* options.valid(existing.value))) {
            return existing.value;
          }
          yield* Ref.update(states, (map) => {
            if (map.get(key) !== existing) return map;
            const next = new Map(map);
            next.delete(key);
            return next;
          });
          return yield* run(key, work);
        }
        yield* work.pipe(
          Effect.onExit((exit) =>
            settle(key, exit).pipe(Effect.andThen(Deferred.done(done, exit))),
          ),
          Effect.forkIn(scope),
        );
        return yield* Deferred.await(done);
      });
      return run;
    }),
  );
