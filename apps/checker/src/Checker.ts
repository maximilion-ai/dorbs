import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  Change,
  CheckRequest,
  CheckResponse,
  CheckRun,
  Rejected,
  RejectReason,
  TestRequest,
  TestResponse,
} from "@dorbs/protocol/checker";
import type { CommitSha, RelativePath } from "@dorbs/protocol/typecheck";

import { parseOutput } from "./diagnostics.ts";
import { Docker, type ImageMissing, REPO_ROOT } from "./Docker.ts";
import { detect, workspacePackages } from "./detect.ts";
import { type EnvSpec, Environments, type Session } from "./Environments.ts";
import { type FetchFailed, Git } from "./Git.ts";
import type { Check, Recipe, RepoView } from "./Recipe.ts";
import { type Repo, ServiceConfig } from "./ServiceConfig.ts";
import { quote, testCommands } from "./testCommand.ts";
import { testCounts } from "./testSummary.ts";
import type { UnsafePath } from "./Tree.ts";

export class Checker extends Context.Service<
  Checker,
  {
    readonly check: (
      request: CheckRequest,
    ) => Effect.Effect<CheckResponse, FetchFailed | ImageMissing>;
    readonly test: (
      request: TestRequest,
    ) => Effect.Effect<TestResponse, FetchFailed | ImageMissing>;
  }
>()("dorbs/checker/Checker") {}

const OVERRIDE = ".dorbs/check.json";
// What a check's answer carries of the lines no parser read, and a test's of its output.
const OUTPUT_LINES = 200;
const OUTPUT_BYTES = 32 * 1024;
const RUN_KEEP_BYTES = 2 * 1024 * 1024;

const rejected = (reason: RejectReason): Rejected => ({ _tag: "Rejected", reason });
const unsafe = (error: UnsafePath) =>
  Effect.succeed(rejected({ _tag: "UnsafePath", paths: error.paths }));

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/**
 * The commit's files with the change laid over them. The recipe file comes from the operator or the
 * commit, never from the change: setup steps reach the network, so only those who can push choose them.
 */
const viewOf = (
  paths: ReadonlyArray<RelativePath>,
  inputs: ReadonlyMap<string, string>,
  change: Change,
  repo: Repo,
): RepoView => {
  const files = new Map(inputs);
  const deleted = new Set<string>(change.deleted);
  for (const path of deleted) if (path !== OVERRIDE) files.delete(path);
  for (const file of change.files) if (file.path !== OVERRIDE) files.set(file.path, file.content);
  if (repo.recipe !== undefined) files.set(OVERRIDE, repo.recipe);
  const all = new Set<RelativePath>([
    ...paths.filter((path) => !deleted.has(path)),
    ...change.files.map((f) => f.path),
  ]);
  return { paths: [...all].toSorted(), read: (path) => files.get(path) };
};

/** Workspace package directories by package name, for output that names packages rather than paths. */
const packagesByName = (view: RepoView): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();
  for (const path of view.paths.filter((p) => p.endsWith("package.json"))) {
    try {
      const json: unknown = JSON.parse(view.read(path) ?? "");
      if (
        typeof json === "object" &&
        json !== null &&
        "name" in json &&
        typeof json.name === "string"
      ) {
        names.set(json.name, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
      }
    } catch {
      // Not every package.json parses; such a package is just not named.
    }
  }
  return names;
};

/** The output lines a result carries: the first ones, within a line and a byte cap. */
const capLines = (lines: ReadonlyArray<string>) => {
  const kept: Array<string> = [];
  let bytes = 0;
  for (const line of lines) {
    bytes += line.length + 1;
    if (kept.length >= OUTPUT_LINES || bytes > OUTPUT_BYTES) return { lines: kept, cut: true };
    kept.push(line);
  }
  return { lines: kept, cut: false };
};

const make = Effect.gen(function* () {
  const config = yield* ServiceConfig;
  const git = yield* Git;
  const docker = yield* Docker;
  const environments = yield* Environments;

  /** Resolves a request to its recipe and environment, or why it cannot run. */
  const prepare = Effect.fn("Checker.prepare")(function* (request: {
    readonly repo: CheckRequest["repo"];
    readonly commit: CommitSha;
    readonly change: Change;
  }) {
    const repo = config.repos.get(request.repo);
    if (repo === undefined) return rejected({ _tag: "UnknownRepo" });
    const gitDir = yield* git
      .fetch(repo, request.commit)
      .pipe(Effect.catchTags({ UnknownCommit: () => Effect.succeed(undefined) }));
    if (gitDir === undefined) return rejected({ _tag: "UnknownCommit" });
    const { paths, inputs } = yield* git.files(gitDir, request.commit);
    const view = viewOf(paths, inputs, request.change, repo);
    const recipe = detect(view);
    if ("reason" in recipe) return rejected({ _tag: "NoRecipe", reason: recipe.reason });
    const image = yield* docker.imageId(recipe.image);
    const keyFiles = new Set<string>(recipe.keyFiles);
    const key = sha256(
      JSON.stringify({
        repo: repo.id,
        image,
        recipe,
        keyFiles: recipe.keyFiles.map((path) => [path, sha256(view.read(path) ?? "\0absent")]),
      }),
    );
    const spec: EnvSpec = {
      key,
      repo: repo.id,
      gitDir,
      recipe,
      image,
      keyChange: {
        files: request.change.files.filter((file) => keyFiles.has(file.path)),
        deleted: request.change.deleted.filter((path) => keyFiles.has(path)),
      },
    };
    return { spec, view };
  });

  const runCheck = Effect.fn("Checker.runCheck")(function* (
    session: Session,
    check: Check,
    change: Change,
    packages: ReadonlyMap<string, string>,
  ) {
    const started = yield* Clock.currentTimeMillis;
    const prefix = check.cwd === "." ? "" : `${check.cwd}/`;
    const changed = change.files.map((file) => file.path).filter((path) => path.startsWith(prefix));
    if (check.scope === "changed" && changed.length === 0) {
      return {
        id: check.id,
        command: check.run,
        status: "skipped",
        exitCode: null,
        durationMs: 0,
        diagnostics: [],
        output: ["No changed files under this check's directory."],
        truncated: false,
      } satisfies CheckRun;
    }
    const run =
      check.scope === "changed"
        ? `${check.run} ${changed.map((path) => quote(path.slice(prefix.length))).join(" ")}`
        : check.run;
    const result = yield* session.exec({
      cwd: check.cwd,
      run,
      timeout: config.checkTimeout,
      keepBytes: RUN_KEEP_BYTES,
    });
    const parsed = parseOutput(check.format, result.stdout, result.stderr, {
      root: REPO_ROOT,
      cwd: check.cwd,
      source: check.id,
      packages,
    });
    const output = capLines(parsed.output);
    return {
      id: check.id,
      command: run,
      status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "passed" : "failed",
      exitCode: result.exitCode,
      durationMs: (yield* Clock.currentTimeMillis) - started,
      diagnostics: parsed.diagnostics,
      output: output.lines,
      truncated: result.truncated || output.cut,
    } satisfies CheckRun;
  });

  const check: Checker["Service"]["check"] = Effect.fn("Checker.check")(function* (request) {
    const started = yield* Clock.currentTimeMillis;
    const prepared = yield* prepare(request);
    if ("_tag" in prepared) return prepared;
    const { spec, view } = prepared;
    const known = spec.recipe.checks.map((c) => c.id);
    const unknown = (request.only ?? []).filter((id) => !known.includes(id));
    if (unknown.length > 0) return rejected({ _tag: "UnknownChecks", ids: unknown, known });
    const checks = spec.recipe.checks.filter(
      (c) => request.only === undefined || request.only.includes(c.id),
    );
    const packages = packagesByName(view);
    const used = yield* environments
      .use(spec, request.commit, request.change, (session) =>
        Effect.forEach(checks, (c) => runCheck(session, c, request.change, packages)),
      )
      .pipe(Effect.catchTags({ UnsafePath: unsafe }));
    if (used._tag !== "Used") return used;
    const durationMs = (yield* Clock.currentTimeMillis) - started;
    yield* Effect.logInfo(
      `check ${request.repo}@${request.commit.slice(0, 12)} env ${spec.key.slice(0, 12)}: ${used.value.map((run) => `${run.id}=${run.status}/${run.diagnostics.length}`).join(" ")} in ${durationMs} ms (setup ${used.setupMs}, overlay ${used.overlayMs})`,
    );
    return {
      _tag: "CheckResult",
      envKey: spec.key,
      durationMs,
      setupMs: used.setupMs,
      overlayMs: used.overlayMs,
      scope: checks.some((c) => c.scope === "changed") ? "changed" : "repo",
      complete: used.value.every(
        (run) => (run.status === "passed" || run.status === "failed") && !run.truncated,
      ),
      checks: used.value,
    } as const;
  });

  const test: Checker["Service"]["test"] = Effect.fn("Checker.test")(function* (request) {
    const started = yield* Clock.currentTimeMillis;
    const prepared = yield* prepare(request);
    if ("_tag" in prepared) return prepared;
    const { spec, view } = prepared;
    const recipe: Recipe = spec.recipe;
    if (recipe.test === undefined) {
      return rejected({
        _tag: "NoTestCommand",
        reason: "The service found no test command for this repo.",
      });
    }
    const commands = testCommands(recipe.test, request, workspacePackages(view));
    if ("reason" in commands) return rejected({ _tag: "NoTestCommand", reason: commands.reason });
    const used = yield* environments
      .use(spec, request.commit, request.change, (session) =>
        Effect.forEach(commands, (command) =>
          session.exec({ ...command, timeout: config.testTimeout, keepBytes: RUN_KEEP_BYTES }),
        ),
      )
      .pipe(Effect.catchTags({ UnsafePath: unsafe }));
    if (used._tag !== "Used") return used;
    const runs = used.value;
    const output = runs
      .map((run) => `${run.stdout}${run.stderr === "" ? "" : `\n${run.stderr}`}`)
      .join("\n");
    const counts = runs.map((run) => testCounts(`${run.stdout}\n${run.stderr}`));
    const failed = runs.find((run) => run.exitCode !== 0);
    const total = (field: "passed" | "failed" | "skipped") =>
      counts.every((c) => c !== undefined)
        ? counts.reduce((sum, c) => sum + (c?.[field] ?? 0), 0)
        : undefined;
    const [passed, failedCount, skipped] = [total("passed"), total("failed"), total("skipped")];
    const encoded = Buffer.from(output);
    const durationMs = (yield* Clock.currentTimeMillis) - started;
    yield* Effect.logInfo(
      `test ${request.repo}@${request.commit.slice(0, 12)} env ${spec.key.slice(0, 12)}: exit ${failed?.exitCode ?? 0}, ${passed ?? "?"} passed, ${failedCount ?? "?"} failed in ${durationMs} ms (setup ${used.setupMs}, overlay ${used.overlayMs})`,
    );
    return {
      _tag: "TestResult",
      envKey: spec.key,
      durationMs,
      setupMs: used.setupMs,
      overlayMs: used.overlayMs,
      command: commands.map((command) => command.run).join(" && "),
      status: runs.some((run) => run.timedOut)
        ? "timed_out"
        : failed === undefined
          ? "passed"
          : "failed",
      exitCode: failed === undefined ? 0 : failed.exitCode,
      ...(passed === undefined ? {} : { passed }),
      ...(failedCount === undefined ? {} : { failed: failedCount }),
      ...(skipped === undefined ? {} : { skipped }),
      // A test run's failures and summary come last, so its end is what stays.
      output: encoded.length > OUTPUT_BYTES ? encoded.subarray(-OUTPUT_BYTES).toString() : output,
      truncated: encoded.length > OUTPUT_BYTES || runs.some((run) => run.truncated),
    } as const;
  });

  return Checker.of({ check, test });
});

export const layer = Layer.effect(Checker, make);
