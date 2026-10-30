import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { ServiceConfig } from "./ServiceConfig.ts";

/**
 * The bytes the service keeps on disk: blobs, action results, checkouts and installs, each a file
 * or directory that `record` counts. Past the budget, the next check first removes what was used
 * least recently. Eviction waits for every running check and holds new ones, so it never removes
 * a tree a check reads.
 */
export class Storage extends Context.Service<
  Storage,
  {
    /** Runs a check. Evicts first when the kept bytes exceed the budget. */
    readonly use: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** Counts `path`, just written, as used now. */
    readonly record: (path: string) => Effect.Effect<void>;
    /** Marks `path` as used now. */
    readonly touch: (path: string) => Effect.Effect<void>;
    /** Counts paths that were on disk at startup, in the background, by their mtime. */
    readonly adopt: (paths: ReadonlyArray<string>) => Effect.Effect<void>;
  }
>()("dorbs/typecheck/Storage") {}

// Checks take one permit each; eviction takes them all.
const ALL = Number.MAX_SAFE_INTEGER;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { cacheMaxBytes } = yield* ServiceConfig;
  const scope = yield* Effect.scope;
  const entries = new Map<string, { readonly bytes: number; readonly used: number }>();
  let total = 0;
  const checks = yield* Semaphore.make(ALL);
  const evictTurn = yield* Semaphore.make(1);

  const count = (file: string, bytes: number, used: number) => {
    total += bytes - (entries.get(file)?.bytes ?? 0);
    entries.set(file, { bytes, used });
  };

  // Hard links into the pnpm store count in full, so installs weigh more than they free. A pnpm
  // install also links to its siblings, in cycles, so the walk never follows a link, and counts a
  // file that two hard links name once.
  const sizeOf = Effect.fn("Storage.sizeOf")(function* (target: string) {
    const seen = new Set<string>();
    let total = 0;
    // One directory level at a time.
    let level: ReadonlyArray<string> = [target];
    while (level.length > 0) {
      const children = yield* Effect.forEach(
        level,
        (file) =>
          fs.lstat(file).pipe(
            Effect.flatMap((info) => {
              if (info.type === "Directory") {
                return fs
                  .readDirectory(file)
                  .pipe(Effect.map((names) => names.map((name) => path.join(file, name))));
              }
              const inode = `${info.dev}:${Option.getOrElse(info.ino, () => file)}`;
              if (info.type === "File" && !seen.has(inode)) {
                seen.add(inode);
                total += Number(info.size);
              }
              return Effect.succeed([]);
            }),
            Effect.orElseSucceed(() => []),
          ),
        { concurrency: 32 },
      );
      level = children.flat();
    }
    return total;
  });

  const record: Storage["Service"]["record"] = Effect.fn("Storage.record")(function* (target) {
    count(
      target,
      yield* sizeOf(target).pipe(Effect.orElseSucceed(() => 0)),
      yield* Clock.currentTimeMillis,
    );
  });

  const touch: Storage["Service"]["touch"] = Effect.fn("Storage.touch")(function* (target) {
    const now = yield* Clock.currentTimeMillis;
    const entry = entries.get(target);
    if (entry !== undefined) entries.set(target, { ...entry, used: now });
    // The mtime carries the order across a restart.
    yield* fs.utimes(target, new Date(now), new Date(now)).pipe(Effect.ignore);
  });

  const adopt: Storage["Service"]["adopt"] = (paths) =>
    Effect.forEach(
      paths,
      (target) =>
        Effect.gen(function* () {
          if (entries.has(target)) return;
          const info = yield* fs.stat(target);
          const bytes = yield* sizeOf(target);
          if (!entries.has(target)) {
            count(target, bytes, Option.getOrElse(info.mtime, () => new Date(0)).getTime());
          }
        }).pipe(Effect.ignore),
      { discard: true },
    ).pipe(Effect.forkIn(scope), Effect.asVoid);

  const evict = evictTurn.withPermit(
    Effect.suspend(() =>
      total <= cacheMaxBytes
        ? Effect.void
        : checks.withPermits(ALL)(
            Effect.gen(function* () {
              const oldest = [...entries].toSorted(([, a], [, b]) => a.used - b.used);
              for (const [target, entry] of oldest) {
                if (total <= cacheMaxBytes) break;
                yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore);
                entries.delete(target);
                total -= entry.bytes;
              }
            }),
          ),
    ),
  );

  const use: Storage["Service"]["use"] = (effect) =>
    evict.pipe(Effect.andThen(checks.withPermits(1)(effect)));

  return Storage.of({ use, record, touch, adopt });
});

export const layer = Layer.effect(Storage, make);
