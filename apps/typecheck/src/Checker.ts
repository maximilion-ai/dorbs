import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  type Action,
  type ActionResponse,
  type ActionResult,
  isProtectedPath,
  type RejectReason,
  ToolchainId,
} from "@dorbs/protocol/typecheck";

import { ActionCache, actionDigest } from "./ActionCache.ts";
import { BlobStore } from "./BlobStore.ts";
import { type Checkout, Checkouts, type FetchFailed } from "./Checkouts.ts";
import { parseOxlint, parseTsrs } from "./diagnostics.ts";
import { type InstallFailed, Installs } from "./Installs.ts";
import { runProcess } from "./runProcess.ts";
import { ServiceConfig } from "./ServiceConfig.ts";

export class UnsafeConfig extends Schema.TaggedError<UnsafeConfig>()("UnsafeConfig", {
  options: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `The commit's tsconfig sets options the service does not run: ${this.options.join(", ")}`;
  }
}

export class Checker extends Context.Service<
  Checker,
  {
    readonly run: (
      action: Action,
    ) => Effect.Effect<ActionResponse, InstallFailed | FetchFailed | UnsafeConfig>;
  }
>()("dorbs/typecheck/Checker") {}

// The toolchains this service runs. A new tool version is a new id, so cached results never mix versions.
const TOOLCHAINS: ReadonlySet<ToolchainId> = new Set([
  ToolchainId.make("node26-tsrs0.20-oxlint1.89"),
]);

const rejected = (reason: RejectReason) => ({ _tag: "Rejected", reason }) as const;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const blobs = yield* BlobStore;
  const cache = yield* ActionCache;
  const checkouts = yield* Checkouts;
  const installs = yield* Installs;
  const { dataDir, repos } = yield* ServiceConfig;
  const checksDir = path.join(dataDir, "checks");
  yield* fs.makeDirectory(checksDir, { recursive: true });
  // A client .oxlintrc.json could load jsPlugins, which run as code; only this config applies.
  const oxlintConfig = path.join(dataDir, "oxlintrc.json");
  yield* fs.writeFileString(oxlintConfig, "{}");
  const slots = yield* Semaphore.make(NodeOS.availableParallelism());

  const runTool = Effect.fn("Checker.runTool")(function* (
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
    checkout: Checkout,
    action: Action,
    installDir: string,
  ) {
    const dir = yield* fs.makeTempDirectoryScoped({ directory: checksDir });
    yield* fs.copy(checkout.dir, dir);
    yield* Effect.forEach(
      action.files,
      (file) => {
        const target = path.join(dir, file.path);
        return fs
          .makeDirectory(path.dirname(target), { recursive: true })
          .pipe(Effect.andThen(fs.copyFile(blobs.pathOf(file.sha256), target)));
      },
      { concurrency: 32, discard: true },
    );
    yield* Effect.forEach(
      action.deleted,
      (file) => fs.remove(path.join(dir, file), { force: true }),
      {
        discard: true,
      },
    );
    for (const pkg of checkout.packages) {
      const modules = path.join(installDir, pkg, "node_modules");
      if (yield* fs.exists(modules)) {
        yield* fs.symlink(modules, path.join(dir, pkg, "node_modules"));
      }
    }
    const [tsrs, oxlint] = yield* Effect.all(
      [
        runTool(dir, "tsrs", ["--noEmit", "-p", "tsconfig.json", "--pretty", "false"], [0, 1, 2]),
        runTool(
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

  const run: Checker["Service"]["run"] = Effect.fn("Checker.run")(function* (action) {
    if (!TOOLCHAINS.has(action.toolchain)) return rejected({ _tag: "UnknownToolchain" });
    const repo = repos.get(action.repo);
    if (repo === undefined) return rejected({ _tag: "UnknownRepo" });
    const touched = [...action.files.map((file) => file.path), ...action.deleted];
    const named = touched.filter(isProtectedPath);
    if (named.length > 0) return rejected({ _tag: "ProtectedPaths", paths: named });
    const digest = actionDigest(action);
    const cached = yield* cache.get(digest);
    if (cached !== undefined) return { ...cached, cached: true };
    const missing = yield* blobs.missing(action.files.map((file) => file.sha256));
    if (missing.length > 0) return { _tag: "MissingBlobs", sha256s: missing } as const;
    const checkout = yield* checkouts.ensure(repo, action.commit).pipe(
      Effect.map((checkout): Checkout | undefined => checkout),
      Effect.catchTags({ UnknownCommit: () => Effect.succeed(undefined) }),
    );
    if (checkout === undefined) return rejected({ _tag: "UnknownCommit" });
    const chained = touched.filter((path) => checkout.tsconfigs.has(path));
    if (chained.length > 0) return rejected({ _tag: "ProtectedPaths", paths: chained });
    // Only the commit's own configs can set these, since every chain member is protected.
    if (checkout.unsafeConfig.length > 0) {
      return yield* new UnsafeConfig({ options: checkout.unsafeConfig.toSorted() });
    }
    const [duration, diagnostics] = yield* Effect.timed(
      installs
        .ensure(checkout)
        .pipe(
          Effect.flatMap((installDir) =>
            slots.withPermit(Effect.scoped(runTools(checkout, action, installDir))),
          ),
        ),
    );
    const result: ActionResult = {
      _tag: "ActionResult",
      diagnostics,
      outputs: [],
      durationMs: Duration.toMillis(duration),
      cached: false,
    };
    yield* cache.put(digest, result);
    return result;
  });

  return Checker.of({ run });
});

export const layer = Layer.effect(Checker, make);
