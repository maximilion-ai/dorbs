import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type Diagnostic, RelativePath, ToolName } from "@dorbs/protocol/typecheck";

const LOCATED = /^(.+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const UNLOCATED = /^(error|warning) (TS\d+): (.*)$/;
const isRelativePath = Schema.is(RelativePath);
const CONFIG_PATH = RelativePath.make("tsconfig.json");
const TSRS = ToolName.make("tsrs");
const OXLINT = ToolName.make("oxlint");

// Errors with no file, or in a file outside the project, point at the tsconfig, so a failing check
// never comes back empty. Outside text is withheld, continuation lines included: a tsconfig or an
// import can pull in any readable file, and its errors would quote it.
const OUTSIDE = "Error in a file outside the project.";

const tsrsDiagnostic = (line: string): Diagnostic | undefined => {
  const located = LOCATED.exec(line);
  if (located) {
    const [, path = "", row = "", column = "", severity, code = "", message = ""] = located;
    const inProject = isRelativePath(path);
    return {
      tool: TSRS,
      path: inProject ? path : CONFIG_PATH,
      line: inProject ? Number(row) : 1,
      column: inProject ? Number(column) : 1,
      code,
      message: inProject ? message : OUTSIDE,
      severity: severity === "warning" ? "warning" : "error",
    };
  }
  const unlocated = UNLOCATED.exec(line);
  if (!unlocated) return undefined;
  const [, severity, code = "", message = ""] = unlocated;
  return {
    tool: TSRS,
    path: CONFIG_PATH,
    line: 1,
    column: 1,
    code,
    message,
    severity: severity === "warning" ? "warning" : "error",
  };
};

/** Parses `tsrs --pretty false` output. Indented lines continue the previous message. */
export const parseTsrs = (output: string): ReadonlyArray<Diagnostic> => {
  const diagnostics: Array<Diagnostic> = [];
  for (const line of output.split("\n")) {
    const last = diagnostics.at(-1);
    if (last && /^\s/.test(line) && line.trim() !== "") {
      if (last.message !== OUTSIDE) {
        diagnostics[diagnostics.length - 1] = { ...last, message: `${last.message}\n${line}` };
      }
      continue;
    }
    const diagnostic = tsrsDiagnostic(line);
    if (diagnostic) diagnostics.push(diagnostic);
  }
  return diagnostics;
};

const OxlintOutput = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      message: Schema.String,
      // A parse error has no rule, so no code.
      code: Schema.optionalKey(Schema.String),
      severity: Schema.String,
      filename: RelativePath,
      labels: Schema.Array(
        Schema.Struct({ span: Schema.Struct({ line: Schema.Int, column: Schema.Int }) }),
      ),
    }),
  ),
});
const decodeOxlintOutput = Schema.decodeEffect(Schema.fromJsonString(OxlintOutput));

/** Parses `oxlint --format json` output. */
export const parseOxlint = Effect.fn("parseOxlint")(function* (output: string) {
  const { diagnostics } = yield* decodeOxlintOutput(output);
  return diagnostics.map((diagnostic): Diagnostic => ({
    tool: OXLINT,
    path: diagnostic.filename,
    line: Math.max(1, diagnostic.labels[0]?.span.line ?? 1),
    column: Math.max(1, diagnostic.labels[0]?.span.column ?? 1),
    code: diagnostic.code ?? "",
    message: diagnostic.message,
    severity: diagnostic.severity === "error" ? "error" : "warning",
  }));
});
