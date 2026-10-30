import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";

import type { Action } from "@dorbs/protocol/typecheck";

import { BlobStore } from "./BlobStore.ts";
import type { Checkout } from "./Checkouts.ts";
import { runProcess } from "./runProcess.ts";
import { ServiceConfig } from "./ServiceConfig.ts";
import { Storage } from "./Storage.ts";

/**
 * Private trees of a checkout, cloned once and reused one check at a time: after a check, each path
 * it touched gets the checkout's version back. The tools write nothing there (no tsconfig option
 * that writes passes, oxlint keeps no cache). A tree whose check failed is discarded.
 */
export class CheckTrees extends Context.Service<
  CheckTrees,
  {
    /** A tree of `checkout` with `action`'s changes and the install's node_modules, for the scope. */
    readonly open: (
      checkout: Checkout,
      action: Action,
      installDir: string,
    ) => Effect.Effect<string, never, Scope.Scope>;
  }
>()("dorbs/typecheck/CheckTrees") {}

// APFS clones and Linux reflinks share blocks until a write, so a tree does not copy the checkout.
const CLONE =
  process.platform === "darwin"
    ? ["-cR"]
    : process.platform === "linux"
      ? ["-R", "--reflink=auto"]
      : undefined;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const blobs = yield* BlobStore;
  const storage = yield* Storage;
  const { dataDir, processTimeout } = yield* ServiceConfig;
  const scope = yield* Effect.scope;
  const checksDir = path.join(dataDir, "checks");
  yield* fs.makeDirectory(checksDir, { recursive: true });
  // Whatever a previous run left may be mid-check, so none of it is reused.
  const discard = (dir: string) =>
    fs.remove(dir, { recursive: true }).pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid);
  yield* Effect.forEach(
    yield* fs.readDirectory(checksDir),
    (name) => discard(path.join(checksDir, name)),
    { discard: true },
  );
  // Idle trees by the checkout they clone.
  const idle = new Map<string, Array<string>>();

  // A filesystem without clones fails `cp -c`, so the copy falls back to bytes.
  const clone = Effect.fn("CheckTrees.clone")(function* (from: string) {
    const to = path.join(checksDir, NodeCrypto.randomUUID());
    yield* fs.makeDirectory(to);
    const cloned =
      CLONE !== undefined &&
      (yield* runProcess(spawner, checksDir, "cp", [...CLONE, `${from}/.`, to], {
        timeout: processTimeout,
      })).exitCode === 0;
    if (!cloned) {
      yield* fs.remove(to, { recursive: true });
      yield* fs.makeDirectory(to);
      yield* fs.copy(from, to);
    }
    yield* storage.record(to);
    return to;
  });

  // Eviction may have removed an idle tree since.
  const take = Effect.fn("CheckTrees.take")(function* (checkout: Checkout) {
    const trees = idle.get(checkout.dir) ?? [];
    for (let tree = trees.pop(); tree !== undefined; tree = trees.pop()) {
      if (yield* fs.exists(tree)) {
        yield* storage.touch(tree);
        return tree;
      }
    }
    return yield* clone(checkout.dir);
  });

  // The checkout's version of `file`: its content, or nothing from the first directory it lacks.
  const restore = Effect.fn("CheckTrees.restore")(function* (
    checkout: Checkout,
    tree: string,
    file: string,
  ) {
    const parts = file.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join("/");
      if (!(yield* fs.exists(path.join(checkout.dir, prefix)))) {
        yield* fs.remove(path.join(tree, prefix), { recursive: true, force: true });
        return;
      }
    }
    yield* fs.copyFile(path.join(checkout.dir, file), path.join(tree, file));
  });

  // Where the filesystem ignores case or Unicode form, restoring a path the checkout spells another
  // way would rename its file, so only a check whose paths are spelled exactly keeps its tree.
  const spelledExactly = Effect.fn("CheckTrees.spelledExactly")(function* (
    checkout: Checkout,
    file: string,
  ) {
    const parts = file.split("/");
    for (const [depth, name] of parts.entries()) {
      const parent = path.join(checkout.dir, ...parts.slice(0, depth));
      if (!(yield* fs.exists(path.join(parent, name)))) return true;
      if (!(yield* fs.readDirectory(parent)).includes(name)) return false;
    }
    return true;
  });

  const open: CheckTrees["Service"]["open"] = (checkout, action, installDir) => {
    const touched = [...action.files.map((file) => file.path), ...action.deleted];
    const links: Array<string> = [];
    const close = (tree: string, exit: Exit.Exit<unknown, unknown>) =>
      Exit.isFailure(exit)
        ? discard(tree)
        : Effect.gen(function* () {
            for (const file of touched) {
              if (!(yield* spelledExactly(checkout, file))) {
                yield* discard(tree);
                return;
              }
            }
            for (const link of links) yield* fs.remove(link);
            for (const file of touched) yield* restore(checkout, tree, file);
            idle.set(checkout.dir, [...(idle.get(checkout.dir) ?? []), tree]);
          }).pipe(Effect.catch(() => discard(tree)));
    return Effect.acquireRelease(take(checkout).pipe(Effect.orDie), close).pipe(
      Effect.tap((tree) =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            action.files,
            (file) => {
              const target = path.join(tree, file.path);
              return fs
                .makeDirectory(path.dirname(target), { recursive: true })
                .pipe(Effect.andThen(fs.copyFile(blobs.pathOf(file.sha256), target)));
            },
            { concurrency: 32, discard: true },
          );
          yield* Effect.forEach(
            action.deleted,
            (file) => fs.remove(path.join(tree, file), { force: true }),
            { discard: true },
          );
          for (const pkg of checkout.packages) {
            const modules = path.join(installDir, pkg, "node_modules");
            if (yield* fs.exists(modules)) {
              const link = path.join(tree, pkg, "node_modules");
              yield* fs.symlink(modules, link);
              links.push(link);
            }
          }
        }).pipe(Effect.orDie),
      ),
    );
  };

  return CheckTrees.of({ open });
});

export const layer = Layer.effect(CheckTrees, make);
