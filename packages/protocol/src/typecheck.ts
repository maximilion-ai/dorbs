import * as Schema from "effect/Schema";

export const Sha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/, { expected: "a lowercase hex SHA-256" })),
  Schema.brand("Sha256"),
);
export type Sha256 = typeof Sha256.Type;

// Slash-separated segments, none empty, `.` or `..`, so a path cannot leave the project root.
export const RelativePath = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[^/\\\0]+(?:\/[^/\\\0]+)*$/, {
      expected: "a relative POSIX path without . or .. segments",
    }),
  ),
  Schema.brand("RelativePath"),
);
export type RelativePath = typeof RelativePath.Type;

export const CheckRequest = Schema.Struct({
  lockfile: Sha256,
  files: Schema.Array(Schema.Struct({ path: RelativePath, sha256: Sha256 })),
});
export type CheckRequest = typeof CheckRequest.Type;

const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const Diagnostic = Schema.Struct({
  tool: Schema.Literals(["tsrs", "oxlint"]),
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

const CheckResult = Schema.TaggedStruct("CheckResult", {
  diagnostics: Schema.Array(Diagnostic),
  durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type CheckResult = typeof CheckResult.Type;

export const CheckResponse = Schema.Union([MissingBlobs, CheckResult]);
export type CheckResponse = typeof CheckResponse.Type;
