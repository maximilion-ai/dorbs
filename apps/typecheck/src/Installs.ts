import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { Sha256 } from "@dorbs/protocol/typecheck";

import type { Checkout } from "./Checkouts.ts";
import { installWorkspace, patchFiles } from "./pnpmWorkspace.ts";
import { leavesRepo } from "./repoPaths.ts";
import { runProcess } from "./runProcess.ts";
import { ServiceConfig } from "./ServiceConfig.ts";
import * as SingleFlight from "./SingleFlight.ts";
import { Storage } from "./Storage.ts";

export class InstallFailed extends Schema.TaggedError<InstallFailed>()("InstallFailed", {
  lockfile: Sha256,
  output: Schema.String,
}) {
  override get message(): string {
    return `pnpm install failed for lockfile ${this.lockfile}:\n${this.output}`;
  }
}

export class UnsupportedPackageManager extends Schema.TaggedError<UnsupportedPackageManager>()(
  "UnsupportedPackageManager",
  { name: Schema.String },
) {
  override get message(): string {
    return `The commit pins the package manager ${this.name}; the service installs with pnpm only.`;
  }
}

export class Installs extends Context.Service<
  Installs,
  {
    /** Returns the directory holding node_modules for the checkout's lockfile. */
    readonly ensure: (
      checkout: Checkout,
    ) => Effect.Effect<string, InstallFailed | UnsupportedPackageManager>;
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
  const storage = yield* Storage;
  yield* storage.adopt(
    (yield* fs.readDirectory(root))
      .filter((name) => !name.startsWith("."))
      .map((name) => path.join(root, name)),
  );
  const once = yield* SingleFlight.make<string, InstallFailed>({
    keep: 256,
    // Eviction may have removed the install since.
    valid: (dir) => fs.exists(dir).pipe(Effect.orElseSucceed(() => false)),
  });
  // Installs run before a check takes its slot, so they get their own bound.
  const slots = yield* Semaphore.make(2);

  const install = Effect.fn("Installs.install")(function* (checkout: Checkout) {
    const dir = path.join(root, checkout.lockfile);
    if (yield* fs.exists(dir).pipe(Effect.orDie)) return dir;
    const read = (file: string) =>
      fs
        .readFileString(path.join(checkout.dir, file))
        .pipe(Effect.orElseSucceed((): string | undefined => undefined));
    const workspace = yield* read("pnpm-workspace.yaml");
    const patches = patchFiles(yield* read("package.json"), workspace);
    // pnpm reads a patch from where the config says, even outside the install.
    const outside = patches.filter((patch) => leavesRepo("package.json", patch));
    if (outside.length > 0) {
      return yield* new InstallFailed({
        lockfile: checkout.lockfile,
        output: `The commit's pnpm config names patch files outside the repo: ${outside.join(", ")}`,
      });
    }
    const staging = path.join(root, `.staging-${NodeCrypto.randomUUID()}`);
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(staging);
      const copy = (file: string) =>
        fs
          .makeDirectory(path.dirname(path.join(staging, file)), { recursive: true })
          .pipe(
            Effect.andThen(fs.copyFile(path.join(checkout.dir, file), path.join(staging, file))),
          );
      // No .npmrc: its registry and pnpmfile settings would steer the shared install.
      for (const manifest of checkout.packages.map((dir) => path.join(dir, "package.json"))) {
        yield* copy(manifest);
      }
      // A missing patch is pnpm's to report.
      for (const patch of patches) {
        const info = yield* fs.stat(path.join(checkout.dir, patch)).pipe(Effect.option);
        if (Option.isSome(info) && info.value.type === "File") yield* copy(patch);
      }
      const lockfile = path.join(checkout.dir, "pnpm-lock.yaml");
      yield* (yield* fs.exists(lockfile))
        ? fs.copyFile(lockfile, path.join(staging, "pnpm-lock.yaml"))
        : fs.writeFileString(path.join(staging, "pnpm-lock.yaml"), "");
      if (workspace !== undefined) {
        yield* fs.writeFileString(
          path.join(staging, "pnpm-workspace.yaml"),
          installWorkspace(workspace),
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
      // pnpm runs the version the commit's packageManager pins, also when the host's config says
      // otherwise. An older pnpm it switches to ignores the variable.
      { env: { pnpm_config_pm_on_fail: "download" }, timeout: processTimeout },
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
    yield* storage.record(dir);
    return dir;
  });

  const ensure: Installs["Service"]["ensure"] = (checkout) =>
    checkout.packageManager !== undefined && checkout.packageManager !== "pnpm"
      ? Effect.fail(new UnsupportedPackageManager({ name: checkout.packageManager }))
      : once(checkout.lockfile, slots.withPermit(install(checkout))).pipe(
          Effect.tap(storage.touch),
        );

  return Installs.of({ ensure });
});

export const layer = Layer.effect(Installs, make);
