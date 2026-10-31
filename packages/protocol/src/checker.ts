// The checker service's requests and answers: static checks and tests of a repo at a commit, with an
// agent's changes laid over it, in the warm environment of that repo's dependencies.

import * as Schema from "effect/Schema";

import { CommitSha, RelativePath, RepoId } from "./typecheck.ts";

/** How a workspace differs from the commit it was cloned from. */
export const Change = Schema.Struct({
  /** Files that differ from the commit, new files included, with their whole content. */
  files: Schema.Array(Schema.Struct({ path: RelativePath, content: Schema.String })),
  /** Files of the commit that the workspace deleted. */
  deleted: Schema.Array(RelativePath),
});
export type Change = typeof Change.Type;

/** Names one of a recipe's checks, such as typecheck or lint. */
export const CheckId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9:._-]*$/i, { expected: "a check id" })),
  Schema.brand("CheckId"),
);
export type CheckId = typeof CheckId.Type;

export const CheckRequest = Schema.Struct({
  repo: RepoId,
  commit: CommitSha,
  change: Change,
  /** Runs only these checks; all of the recipe's when absent. */
  only: Schema.optionalKey(Schema.Array(CheckId)),
});
export type CheckRequest = typeof CheckRequest.Type;

export const TestRequest = Schema.Struct({
  repo: RepoId,
  commit: CommitSha,
  change: Change,
  /** Test files, or for pytest, test ids such as tests/test_a.py::test_b. */
  files: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isNonEmpty()))),
  /** A test name pattern: vitest -t, pytest -k, cargo test's filter, go test -run. */
  filter: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
});
export type TestRequest = typeof TestRequest.Type;

/** A zero-based position, as in the Language Server Protocol. */
const Position = Schema.Struct({
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** LSP's DiagnosticSeverity: 1 error, 2 warning, 3 information, 4 hint. */
export const Severity = Schema.Literals([1, 2, 3, 4]);
export type Severity = typeof Severity.Type;

/** An LSP diagnostic with the file it is in, relative to the repo root, and the tool that reported it. */
export const Diagnostic = Schema.Struct({
  path: RelativePath,
  range: Schema.Struct({ start: Position, end: Position }),
  severity: Severity,
  code: Schema.optionalKey(Schema.String),
  /** The tool, such as tsc, eslint or pyright. */
  source: Schema.String,
  message: Schema.String,
});
export type Diagnostic = typeof Diagnostic.Type;

/** How a run ended: exit 0, another exit, killed at its deadline, or not started. */
const RunStatus = Schema.Literals(["passed", "failed", "timed_out", "skipped"]);
export type RunStatus = typeof RunStatus.Type;

export const CheckRun = Schema.Struct({
  id: CheckId,
  command: Schema.String,
  status: RunStatus,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.Finite,
  diagnostics: Schema.Array(Diagnostic),
  /** Output lines no parser understood, so nothing the tool said is dropped. Capped. */
  output: Schema.Array(Schema.String),
  /** Whether the service cut the output at its cap, so diagnostics may be missing. */
  truncated: Schema.Boolean,
});
export type CheckRun = typeof CheckRun.Type;

/** Timings every result carries. */
const Timings = {
  /** The environment the run used: a hash of the repo, the recipe, its key files and the image. */
  envKey: Schema.String,
  durationMs: Schema.Finite,
  /** Time spent setting up the environment, 0 when it was warm. */
  setupMs: Schema.Finite,
  /** Time spent laying the change over the environment's tree and taking it off again. */
  overlayMs: Schema.Finite,
};

const CheckResult = Schema.TaggedStruct("CheckResult", {
  ...Timings,
  /** repo: the checks covered the whole repo. changed: some only looked at the changed files. */
  scope: Schema.Literals(["repo", "changed"]),
  /** Whether every check ran to its end with its whole output read. */
  complete: Schema.Boolean,
  checks: Schema.Array(CheckRun),
});
export type CheckResult = typeof CheckResult.Type;

const TestResult = Schema.TaggedStruct("TestResult", {
  ...Timings,
  command: Schema.String,
  status: RunStatus,
  exitCode: Schema.NullOr(Schema.Int),
  /** Counts the runner reported; undefined when its summary was not found. */
  passed: Schema.optionalKey(Schema.Int),
  failed: Schema.optionalKey(Schema.Int),
  skipped: Schema.optionalKey(Schema.Int),
  /** The runner's output, its tail kept when cut. */
  output: Schema.String,
  truncated: Schema.Boolean,
});
export type TestResult = typeof TestResult.Type;

/** The environment's setup failed; the next request retries it. */
export const SetupFailed = Schema.TaggedStruct("SetupFailed", {
  envKey: Schema.String,
  step: Schema.String,
  output: Schema.String,
});
export type SetupFailed = typeof SetupFailed.Type;

const RejectReason = Schema.Union([
  Schema.TaggedStruct("UnknownRepo", {}),
  Schema.TaggedStruct("UnknownCommit", {}),
  /** The service found no ecosystem it runs in the repo, and the repo has no .dorbs/check.json. */
  Schema.TaggedStruct("NoRecipe", { reason: Schema.String }),
  Schema.TaggedStruct("UnknownChecks", {
    ids: Schema.Array(Schema.String),
    known: Schema.Array(CheckId),
  }),
  Schema.TaggedStruct("NoTestCommand", { reason: Schema.String }),
  /** A path the change writes goes through a symbolic link of the tree. */
  Schema.TaggedStruct("UnsafePath", { paths: Schema.Array(RelativePath) }),
]);
export type RejectReason = typeof RejectReason.Type;

export const Rejected = Schema.TaggedStruct("Rejected", { reason: RejectReason });
export type Rejected = typeof Rejected.Type;

export const CheckResponse = Schema.Union([CheckResult, SetupFailed, Rejected]);
export type CheckResponse = typeof CheckResponse.Type;

export const TestResponse = Schema.Union([TestResult, SetupFailed, Rejected]);
export type TestResponse = typeof TestResponse.Type;
