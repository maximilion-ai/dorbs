import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import { Sha256 } from "@dorbs/protocol/typecheck";

import type { Checkout } from "./Checkouts.ts";
import { installWorkspace } from "./pnpmWorkspace.ts";
import { runProcess } from "./runProcess.ts";
import { ServiceConfig } from "./ServiceConfig.ts";
import * as SingleFlight from "./SingleFlight.ts";

export class InstallFailed extends Schema.TaggedError<InstallFailed>()("InstallFailed", {
  lockfile: Sha256,
  output: Schema.String,
}) {
  override get message(): string {
    return `pnpm install failed for lockfile ${this.lockfile}:\n${this.output}`;
  }
}

export class Installs extends Context.Service<
  Installs,
  {
    /** Returns the directory holding node_modules for the checkout's lockfile. */
    readonly ensure: (checkout: Checkout) => Effect.Effect<string, InstallFailed>;
  }
>()("dorbs/typecheck/Installs") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { dataDir, processTimeout } = yield* ServiceConfig;
  const root = path.join(dataDir, "installs");
  const storeDir = path.join(dataDir, "pnpm-store");
  yield* fs.makeDirectory(root, { recursive: true });
  const once = yield* SingleFlight.make<string, InstallFailed>();

  const install = Effect.fn("Installs.install")(function* (checkout: Checkout) {
    const dir = path.join(root, checkout.lockfile);
    if (yield* fs.exists(dir).pipe(Effect.orDie)) return dir;
    const staging = path.join(root, `.staging-${NodeCrypto.randomUUID()}`);
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(staging);
      // No .npmrc: its registry and pnpmfile settings would steer the shared install.
      for (const manifest of checkout.packages.map((dir) => path.join(dir, "package.json"))) {
        yield* fs.makeDirectory(path.dirname(path.join(staging, manifest)), { recursive: true });
        yield* fs.copyFile(path.join(checkout.dir, manifest), path.join(staging, manifest));
      }
      const lockfile = path.join(checkout.dir, "pnpm-lock.yaml");
      yield* (yield* fs.exists(lockfile))
        ? fs.copyFile(lockfile, path.join(staging, "pnpm-lock.yaml"))
        : fs.writeFileString(path.join(staging, "pnpm-lock.yaml"), "");
      const workspace = path.join(checkout.dir, "pnpm-workspace.yaml");
      if (yield* fs.exists(workspace)) {
        yield* fs.writeFileString(
          path.join(staging, "pnpm-workspace.yaml"),
          installWorkspace(yield* fs.readFileString(workspace)),
        );
      }
    }).pipe(Effect.orDie);
    const result = yield* runProcess(
      spawner,
      staging,
      "pnpm",
      [
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        // A pnpmfile's hooks would run as code in the service.
        "--ignore-pnpmfile",
        "--store-dir",
        storeDir,
      ],
      { timeout: processTimeout },
    ).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.succeed({ exitCode: -1, stdout: "", stderr: error.message }),
        ProcessFailed: (error) =>
          Effect.succeed({ exitCode: -1, stdout: "", stderr: error.message }),
      }),
    );
    if (result.exitCode !== 0) {
      yield* fs.remove(staging, { recursive: true }).pipe(Effect.orDie);
      return yield* new InstallFailed({
        lockfile: checkout.lockfile,
        output: `${result.stdout}${result.stderr}`.slice(-4000),
      });
    }
    yield* fs.rename(staging, dir).pipe(Effect.orDie);
    return dir;
  });

  const ensure: Installs["Service"]["ensure"] = (checkout) =>
    once(checkout.lockfile, install(checkout));

  return Installs.of({ ensure });
});

export const layer = Layer.effect(Installs, make);
