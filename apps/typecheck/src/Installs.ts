import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { type CheckRequest, Sha256 } from "@dorbs/protocol/typecheck";

import { BlobStore } from "./BlobStore.ts";
import { runProcess } from "./runProcess.ts";
import { ServiceConfig } from "./ServiceConfig.ts";

export class InstallFailed extends Schema.TaggedError<InstallFailed>()("InstallFailed", {
  lockfile: Sha256,
  output: Schema.String,
}) {
  override get message(): string {
    return `pnpm install failed for lockfile ${this.lockfile}:\n${this.output}`;
  }
}

// A failed install leaves no entry, so the next check on that lockfile retries it.
type InstallState =
  | { readonly _tag: "Installing"; readonly done: Deferred.Deferred<string, InstallFailed> }
  | { readonly _tag: "Ready"; readonly dir: string };

export class Installs extends Context.Service<
  Installs,
  {
    /** Returns the directory holding node_modules for the request's lockfile. */
    readonly ensure: (request: CheckRequest) => Effect.Effect<string, InstallFailed>;
  }
>()("dorbs/typecheck/Installs") {}

export const isManifest = (path: string) =>
  path === "package.json" || path.endsWith("/package.json") || path === "pnpm-workspace.yaml";

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const blobs = yield* BlobStore;
  const { dataDir } = yield* ServiceConfig;
  const scope = yield* Effect.scope;
  const root = path.join(dataDir, "installs");
  const storeDir = path.join(dataDir, "pnpm-store");
  yield* fs.makeDirectory(root, { recursive: true });
  const states = yield* Ref.make(new Map<Sha256, InstallState>());

  const install = Effect.fn("Installs.install")(function* (request: CheckRequest) {
    const dir = path.join(root, request.lockfile);
    if (yield* fs.exists(dir).pipe(Effect.orDie)) return dir;
    const staging = path.join(root, `.staging-${NodeCrypto.randomUUID()}`);
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(staging);
      yield* fs.copyFile(blobs.pathOf(request.lockfile), path.join(staging, "pnpm-lock.yaml"));
      for (const file of request.files.filter((file) => isManifest(file.path))) {
        const target = path.join(staging, file.path);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.copyFile(blobs.pathOf(file.sha256), target);
      }
    }).pipe(Effect.orDie);
    const result = yield* runProcess(
      spawner,
      ChildProcess.make(
        "pnpm",
        ["install", "--frozen-lockfile", "--ignore-scripts", "--store-dir", storeDir],
        { cwd: staging },
      ),
    ).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.succeed({ exitCode: -1, stdout: "", stderr: error.message }),
      }),
    );
    if (result.exitCode !== 0) {
      yield* fs.remove(staging, { recursive: true }).pipe(Effect.orDie);
      return yield* new InstallFailed({
        lockfile: request.lockfile,
        output: `${result.stdout}${result.stderr}`.slice(-4000),
      });
    }
    yield* fs.rename(staging, dir).pipe(Effect.orDie);
    return dir;
  });

  const settle = (lockfile: Sha256, exit: Exit.Exit<string, InstallFailed>) =>
    Ref.update(states, (map) => {
      const next = new Map(map);
      if (Exit.isSuccess(exit)) next.set(lockfile, { _tag: "Ready", dir: exit.value });
      else next.delete(lockfile);
      return next;
    });

  const ensure: Installs["Service"]["ensure"] = Effect.fn("Installs.ensure")(function* (request) {
    const done = yield* Deferred.make<string, InstallFailed>();
    const existing = yield* Ref.modify(states, (map) => {
      const state = map.get(request.lockfile);
      if (state) return [state, map];
      return [undefined, new Map(map).set(request.lockfile, { _tag: "Installing", done })];
    });
    if (existing?._tag === "Ready") return existing.dir;
    if (existing?._tag === "Installing") return yield* Deferred.await(existing.done);
    // Forked into the service scope so a client hanging up does not cancel an install others await.
    yield* install(request).pipe(
      Effect.onExit((exit) =>
        settle(request.lockfile, exit).pipe(Effect.andThen(Deferred.done(done, exit))),
      ),
      Effect.forkIn(scope),
    );
    return yield* Deferred.await(done);
  });

  return Installs.of({ ensure });
});

export const layer = Layer.effect(Installs, make);
