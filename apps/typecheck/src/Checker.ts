import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Semaphore from "effect/Semaphore";

import type { CheckRequest, CheckResponse } from "@dorbs/protocol/typecheck";

import { BlobStore } from "./BlobStore.ts";
import { parseOxlint, parseTsrs } from "./diagnostics.ts";
import { type InstallFailed, Installs, isManifest } from "./Installs.ts";
import { runProcess } from "./runProcess.ts";
import { ServiceConfig } from "./ServiceConfig.ts";

export class Checker extends Context.Service<
  Checker,
  {
    readonly check: (request: CheckRequest) => Effect.Effect<CheckResponse, InstallFailed>;
  }
>()("dorbs/typecheck/Checker") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const blobs = yield* BlobStore;
  const installs = yield* Installs;
  const { dataDir } = yield* ServiceConfig;
  const checksDir = path.join(dataDir, "checks");
  yield* fs.makeDirectory(checksDir, { recursive: true });
  // A client .oxlintrc.json could load jsPlugins, which run as code; only this config applies.
  const oxlintConfig = path.join(dataDir, "oxlintrc.json");
  yield* fs.writeFileString(oxlintConfig, "{}");
  const slots = yield* Semaphore.make(NodeOS.availableParallelism());

  const run = Effect.fn("Checker.run")(function* (
    cwd: string,
    command: string,
    args: ReadonlyArray<string>,
    okExitCodes: ReadonlyArray<number>,
  ) {
    const result = yield* runProcess(spawner, cwd, command, args).pipe(Effect.orDie);
    if (!okExitCodes.includes(result.exitCode)) {
      return yield* Effect.die(
        new Error(`${command} exited ${result.exitCode}: ${result.stderr}${result.stdout}`),
      );
    }
    return result;
  });

  const runTools = Effect.fn("Checker.runTools")(function* (
    request: CheckRequest,
    installDir: string,
  ) {
    const dir = yield* fs.makeTempDirectoryScoped({ directory: checksDir });
    yield* Effect.forEach(
      request.files,
      (file) => {
        const target = path.join(dir, file.path);
        return fs
          .makeDirectory(path.dirname(target), { recursive: true })
          .pipe(Effect.andThen(fs.copyFile(blobs.pathOf(file.sha256), target)));
      },
      { concurrency: 32, discard: true },
    );
    for (const manifest of request.files.filter((file) => isManifest(file.path))) {
      const modules = path.join(installDir, path.dirname(manifest.path), "node_modules");
      if (yield* fs.exists(modules)) {
        yield* fs.symlink(modules, path.join(dir, path.dirname(manifest.path), "node_modules"));
      }
    }
    const [tsrs, oxlint] = yield* Effect.all(
      [
        run(dir, "tsrs", ["--noEmit", "-p", "tsconfig.json", "--pretty", "false"], [0, 1, 2]),
        run(
          dir,
          "oxlint",
          // oxlint skips node_modules only through a .gitignore, which a check dir lacks.
          [
            "--config",
            oxlintConfig,
            "--disable-nested-config",
            "--format",
            "json",
            "--ignore-pattern",
            "**/node_modules/**",
          ],
          [0, 1],
        ),
      ],
      { concurrency: "unbounded" },
    );
    const typeErrors = parseTsrs(tsrs.stdout);
    if (tsrs.exitCode !== 0 && typeErrors.length === 0) {
      return yield* Effect.die(new Error(`tsrs exited ${tsrs.exitCode}: ${tsrs.stdout}`));
    }
    return [...typeErrors, ...(yield* parseOxlint(oxlint.stdout).pipe(Effect.orDie))];
  }, Effect.orDie);

  const check: Checker["Service"]["check"] = Effect.fn("Checker.check")(function* (request) {
    const missing = yield* blobs.missing([
      request.lockfile,
      ...request.files.map((file) => file.sha256),
    ]);
    if (missing.length > 0) return { _tag: "MissingBlobs", sha256s: missing } as const;
    const [duration, diagnostics] = yield* Effect.timed(
      installs
        .ensure(request)
        .pipe(
          Effect.flatMap((installDir) =>
            slots.withPermit(Effect.scoped(runTools(request, installDir))),
          ),
        ),
    );
    return { _tag: "CheckResult", diagnostics, durationMs: Duration.toMillis(duration) } as const;
  });

  return Checker.of({ check });
});

export const layer = Layer.effect(Checker, make);
