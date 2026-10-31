import * as Schema from "effect/Schema";

export const Sha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/, { expected: "a lowercase hex SHA-256" })),
  Schema.brand("Sha256"),
);
export type Sha256 = typeof Sha256.Type;

const isPathSegment = (segment: string): boolean =>
  segment !== "" && segment !== "." && segment !== ".." && !/[\\\x00-\x1f\x7f]/.test(segment);

// Checked per segment, not with one regex, so no character (a newline included) can hide a `..`.
export const RelativePath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((path: string) => path.split("/").every(isPathSegment), {
      expected: "a relative POSIX path without . or .. segments",
    }),
  ),
  Schema.brand("RelativePath"),
);
export type RelativePath = typeof RelativePath.Type;

const isRepoName = (name: string): boolean =>
  /^[a-z0-9._-]+$/.test(name) && name !== "." && name !== "..";

// The service keeps a repo's cache under its id, so neither half may be `.` or `..`.
export const RepoId = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (id: string) => {
        const names = id.split("/");
        return names.length === 2 && names.every(isRepoName);
      },
      { expected: "a repo id such as owner/name" },
    ),
  ),
  Schema.brand("RepoId"),
);
export type RepoId = typeof RepoId.Type;

export const CommitSha = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/, { expected: "a full lowercase hex commit SHA" })),
  Schema.brand("CommitSha"),
);
export type CommitSha = typeof CommitSha.Type;

// Each decides what gets installed or how tsrs and oxlint run, so a check takes it from the commit.
const PROTECTED_NAMES: ReadonlyArray<RegExp> = [
  /^package\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^pnpm-workspace\.yaml$/i,
  /^\.npmrc$/i,
  /^tsconfig.*\.json$/i,
  /^\.oxlintrc.*\.json$/i,
  /^oxlint\.config\./i,
];

/**
 * Whether a check must take this path from the registered commit rather than from the client.
 * Matches the file name at any depth and ignores case, because macOS volumes do. Anything under
 * node_modules is install output, which the client must not shadow either.
 */
export const isProtectedPath = (path: RelativePath): boolean => {
  const names = path.toLowerCase().split("/");
  return (
    names.includes("node_modules") ||
    PROTECTED_NAMES.some((pattern) => pattern.test(names.at(-1) ?? ""))
  );
};

/** The kinds of action the service runs. */
const ActionKind = Schema.Literals(["check"]);
export type ActionKind = typeof ActionKind.Type;

/** Names a pinned set of tools, such as node26-tsrs0.20-oxlint1.89. */
export const ToolchainId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9.-]*$/, { expected: "a toolchain id" })),
  Schema.brand("ToolchainId"),
);
export type ToolchainId = typeof ToolchainId.Type;

const FileDigest = Schema.Struct({ path: RelativePath, sha256: Sha256 });

/**
 * A pure function of its fields: `kind` run with `toolchain` over `commit` of `repo`, with the
 * client's changes laid over it. The service caches each result under the action's digest.
 */
export const Action = Schema.Struct({
  kind: ActionKind,
  toolchain: ToolchainId,
  repo: RepoId,
  commit: CommitSha,
  /** Files that differ from `commit`, new files included. */
  files: Schema.Array(FileDigest),
  /** Files of `commit` that the client deleted. */
  deleted: Schema.Array(RelativePath),
});
export type Action = typeof Action.Type;

const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Names the tool that reported a diagnostic, such as tsrs or oxlint. */
export const ToolName = Schema.NonEmptyString.pipe(Schema.brand("ToolName"));
export type ToolName = typeof ToolName.Type;

const Diagnostic = Schema.Struct({
  tool: ToolName,
  path: RelativePath,
  line: Position,
  column: Position,
  code: Schema.String,
  message: Schema.String,
  severity: Schema.Literals(["error", "warning"]),
});
export type Diagnostic = typeof Diagnostic.Type;

const MissingBlobs = Schema.TaggedStruct("MissingBlobs", {
  sha256s: Schema.Array(Sha256),
});
export type MissingBlobs = typeof MissingBlobs.Type;

const ActionResult = Schema.TaggedStruct("ActionResult", {
  diagnostics: Schema.Array(Diagnostic),
  /** Files the action wrote, by digest. A check writes none. */
  outputs: Schema.Array(FileDigest),
  durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Whether the service answered from its action cache instead of running the tools. */
  cached: Schema.Boolean,
});
export type ActionResult = typeof ActionResult.Type;

const RejectReason = Schema.Union([
  Schema.TaggedStruct("UnknownToolchain", {}),
  Schema.TaggedStruct("UnknownRepo", {}),
  Schema.TaggedStruct("UnknownCommit", {}),
  Schema.TaggedStruct("ProtectedPaths", { paths: Schema.Array(RelativePath) }),
]);
export type RejectReason = typeof RejectReason.Type;

const Rejected = Schema.TaggedStruct("Rejected", { reason: RejectReason });
export type Rejected = typeof Rejected.Type;

export const ActionResponse = Schema.Union([MissingBlobs, ActionResult, Rejected]);
export type ActionResponse = typeof ActionResponse.Type;
