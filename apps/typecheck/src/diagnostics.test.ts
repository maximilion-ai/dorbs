import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { RelativePath, ToolName } from "@dorbs/protocol/typecheck";

import { parseOxlint, parseTsrs } from "./diagnostics.ts";

it("keeps indented lines with their message and withholds every line of an outside error", () => {
  const output = [
    "src/b.ts(1,14): error TS2322: Type '(a: number) => void' is not assignable to type '(a: string) => void'.",
    "  Types of parameters 'a' and 'a' are incompatible.",
    "    Type 'string' is not assignable to type 'number'.",
    "error TS5058: The specified path does not exist: '/tmp/x/nope.json'.",
    "../deps/node_modules/x/index.d.ts(3,1): error TS1005: ';' expected.",
    "/Users/op/secret.ts(1,7): error TS2322: Type '1' is not assignable to type 'string'.",
    "  Type 'hunter2' is the outside file's value.",
    "",
  ].join("\n");
  assert.deepStrictEqual(parseTsrs(output), [
    {
      tool: ToolName.make("tsrs"),
      path: RelativePath.make("src/b.ts"),
      line: 1,
      column: 14,
      code: "TS2322",
      message:
        "Type '(a: number) => void' is not assignable to type '(a: string) => void'.\n  Types of parameters 'a' and 'a' are incompatible.\n    Type 'string' is not assignable to type 'number'.",
      severity: "error",
    },
    {
      tool: ToolName.make("tsrs"),
      path: RelativePath.make("tsconfig.json"),
      line: 1,
      column: 1,
      code: "TS5058",
      message: "The specified path does not exist: '/tmp/x/nope.json'.",
      severity: "error",
    },
    {
      tool: ToolName.make("tsrs"),
      path: RelativePath.make("tsconfig.json"),
      line: 1,
      column: 1,
      code: "TS1005",
      message: "Error in a file outside the project.",
      severity: "error",
    },
    {
      tool: ToolName.make("tsrs"),
      path: RelativePath.make("tsconfig.json"),
      line: 1,
      column: 1,
      code: "TS2322",
      message: "Error in a file outside the project.",
      severity: "error",
    },
  ]);
});

// SvelteKit's .svelte fixtures: oxlint reports a parse error, which has no rule and so no code.
it.effect("keeps an oxlint parse error, which has no code", () =>
  Effect.gen(function* () {
    const diagnostics = yield* parseOxlint(
      JSON.stringify({
        diagnostics: [
          {
            message:
              "Expected a semicolon or an implicit semicolon after a statement, but found none",
            severity: "error",
            help: "Try inserting a semicolon here",
            filename: "src/lib/Plain.svelte",
            labels: [{ span: { offset: 141, length: 0, line: 9, column: 14 } }],
          },
        ],
      }),
    );
    assert.deepStrictEqual(diagnostics, [
      {
        tool: ToolName.make("oxlint"),
        path: RelativePath.make("src/lib/Plain.svelte"),
        line: 9,
        column: 14,
        code: "",
        message: "Expected a semicolon or an implicit semicolon after a statement, but found none",
        severity: "error",
      },
    ]);
  }),
);
