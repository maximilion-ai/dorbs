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
  type Diagnostic,
  type RejectReason,
  RelativePath,
  type Sha256,
  ToolchainId,
  ToolName,
} from "@dorbs/protocol/typecheck";

import { ActionCache, actionDigest } from "./ActionCache.ts";
import { BlobStore } from "./BlobStore.ts";
import { type Checkout, Checkouts, type FetchFailed } from "./Checkouts.ts";
import { parseOxlint, parseTsrs } from "./diagnostics.ts";
import { type InstallFailed, Installs } from "./Installs.ts";
import { outsideModules } from "./moduleSpecifiers.ts";
import { runProcess } from "./runProcess.ts";
import { type Repo, ServiceConfig } from "./ServiceConfig.ts";
import * as SingleFlight from "./SingleFlight.ts";
import { Storage } from "./Storage.ts";
import { toolBudget } from "./toolBudget.ts";

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

// The files TypeScript reads as modules, so the ones whose imports can reach another file.
const MODULE_FILE = /\.[cm]?[jt]sx?$/i;
const SERVICE = ToolName.make("typecheck");

// APFS clones and Linux reflinks share blocks until a write, so a check does not copy the tree.
const CLONE =
  process.platform === "darwin"
    ? ["-cR"]
    : process.platform === "linux"
      ? ["-R", "--reflink=auto"]
      : undefined;

const OUTSIDE_PROGRAM: Diagnostic = {
  tool: SERVICE,
  path: RelativePath.make("tsconfig.json"),
  line: 1,
  column: 1,
  code: "OutsideModule",
  message:
    "The program reads a file outside the repo and its installed packages, so the service withholds its diagnostics.",
  severity: "error",
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const blobs = yield* BlobStore;
  const cache = yield* ActionCache;
  const checkouts = yield* Checkouts;
  const installs = yield* Installs;
  const storage = yield* Storage;
  const { dataDir, repos, processTimeout } = yield* ServiceConfig;
  const checksDir = path.join(dataDir, "checks");
  yield* fs.makeDirectory(checksDir, { recursive: true });
  // A client .oxlintrc.json could load jsPlugins, which run as code; only this config applies.
  const oxlintConfig = path.join(dataDir, "oxlintrc.json");
  yield* fs.writeFileString(oxlintConfig, "{}");
  // The action cache keeps results, so a flight keeps none once it lands.
  const flights = yield* SingleFlight.make<
    ActionResponse,
    InstallFailed | FetchFailed | UnsafeConfig
  >({ keep: 0 });
  const budget = toolBudget(NodeOS.availableParallelism());
  const slots = yield* Semaphore.make(budget.checks);

  const runTool = Effect.fn("Checker.runTool")(function* (
    cwd: string,
    command: string,
    args: ReadonlyArray<string>,
    okExitCodes: ReadonlyArray<number>,
    env: Record<string, string> = {},
  ) {
    const result = yield* runProcess(spawner, cwd, command, args, {
      env,
      timeout: processTimeout,
    }).pipe(Effect.orDie);
    if (!okExitCodes.includes(result.exitCode)) {
      return yield* Effect.die(
        new Error(`${command} exited ${result.exitCode}: ${result.stderr}${result.stdout}`),
      );
    }
    return result;
  });

  // The directory of the default libs tsrs ships, the one place outside a check its program reads.
  const libDir = yield* Effect.cached(
    Effect.gen(function* () {
      const probe = yield* fs.makeTempDirectoryScoped({ directory: checksDir });
      yield* fs.writeFileString(path.join(probe, "probe.ts"), "");
      yield* fs.writeFileString(
        path.join(probe, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { lib: ["es5"], types: [] }, files: ["probe.ts"] }),
      );
      const { stdout } = yield* runTool(
        probe,
        "tsrs",
        ["-p", "tsconfig.json", "--listFilesOnly"],
        [0],
      );
      const lib = stdout.split("\n").find((line) => line.endsWith("/lib.es5.d.ts"));
      if (lib === undefined) return yield* Effect.die(new Error(`tsrs listed no lib:\n${stdout}`));
      return path.dirname(lib);
    }).pipe(Effect.scoped, Effect.orDie),
  );

  // A filesystem without clones fails `cp -c`, so the copy falls back to bytes.
  const cloneTree = Effect.fn("Checker.cloneTree")(function* (from: string, to: string) {
    const cloned =
      CLONE !== undefined &&
      (yield* runProcess(spawner, checksDir, "cp", [...CLONE, `${from}/.`, to], {
        timeout: processTimeout,
      })).exitCode === 0;
    if (cloned) return;
    yield* fs.remove(to, { recursive: true });
    yield* fs.makeDirectory(to);
    yield* fs.copy(from, to);
  });

  const runTools = Effect.fn("Checker.runTools")(function* (
    checkout: Checkout,
    action: Action,
    installDir: string,
  ) {
    const dir = yield* fs.makeTempDirectoryScoped({ directory: checksDir });
    yield* cloneTree(checkout.dir, dir);
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
        runTool(
          dir,
          "tsrs",
          ["--noEmit", "-p", "tsconfig.json", "--pretty", "false", "--listFiles"],
          [0, 1, 2],
          // tsrs sizes its rayon pool from this.
          { RAYON_NUM_THREADS: String(budget.tsrsThreads) },
        ),
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
            "--threads",
            String(budget.oxlintThreads),
          ],
          [0, 1],
        ),
      ],
      { concurrency: "unbounded" },
    );
    // --listFiles prints each file of the program by absolute real path; module resolution can climb
    // past the check into any ancestor's node_modules, which no scan of the source can see.
    const roots = [dir, installDir, yield* fs.realPath(dir), yield* fs.realPath(installDir)];
    const lib = yield* libDir;
    const read = tsrs.stdout.split("\n").filter((line) => line.startsWith("/"));
    const outside = read.filter(
      (file) => path.dirname(file) !== lib && !roots.some((root) => file.startsWith(`${root}/`)),
    );
    if (outside.length > 0) return [OUTSIDE_PROGRAM];
    const typeErrors = parseTsrs(tsrs.stdout);
    if (tsrs.exitCode !== 0 && typeErrors.length === 0) {
      return yield* Effect.die(new Error(`tsrs exited ${tsrs.exitCode}: ${tsrs.stdout}`));
    }
    return [...typeErrors, ...(yield* parseOxlint(oxlint.stdout).pipe(Effect.orDie))];
  }, Effect.orDie);

  // A tool that read an outside file would quote it in its diagnostics, so no tool sees such an import.
  const outsideImports = Effect.fn("Checker.outsideImports")(function* (action: Action) {
    const diagnostics: Array<Diagnostic> = [];
    for (const file of action.files.filter((file) => MODULE_FILE.test(file.path))) {
      const text = yield* fs.readFileString(blobs.pathOf(file.sha256)).pipe(Effect.orDie);
      for (const { line, column, specifier } of outsideModules(file.path, text)) {
        diagnostics.push({
          tool: SERVICE,
          path: file.path,
          line,
          column,
          code: "OutsideModule",
          message: `"${specifier}" can resolve outside the repo. Import only files in the repo or installed packages.`,
          severity: "error",
        });
      }
    }
    return diagnostics;
  });

  const compute = Effect.fn("Checker.compute")(function* (
    repo: Repo,
    action: Action,
    digest: Sha256,
  ) {
    const cached = yield* cache.get(digest);
    if (cached !== undefined) return { ...cached, cached: true };
    const touched = [...action.files.map((file) => file.path), ...action.deleted];
    const missing = yield* blobs.missing(action.files.map((file) => file.sha256));
    if (missing.length > 0) return { _tag: "MissingBlobs", sha256s: missing } as const;
    yield* Effect.forEach(action.files, (file) => storage.touch(blobs.pathOf(file.sha256)), {
      discard: true,
    });
    const outside = yield* outsideImports(action);
    if (outside.length > 0) {
      const result: ActionResult = {
        _tag: "ActionResult",
        diagnostics: outside,
        outputs: [],
        durationMs: 0,
        cached: false,
      };
      yield* cache.put(digest, result);
      return result;
    }
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
    // Identical actions share one run; the run checks the cache again, in case one just landed.
    return yield* flights(digest, storage.use(compute(repo, action, digest)));
  });

  return Checker.of({ run });
});

export const layer = Layer.effect(Checker, make);
