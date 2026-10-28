import { assert, it } from "@effect/vitest";

import { RelativePath } from "@dorbs/protocol/typecheck";

import { parseTsrs } from "./diagnostics.ts";

it("keeps indented lines with their message and pins config errors to tsconfig.json", () => {
  const output = [
    "src/b.ts(1,14): error TS2322: Type '(a: number) => void' is not assignable to type '(a: string) => void'.",
    "  Types of parameters 'a' and 'a' are incompatible.",
    "    Type 'string' is not assignable to type 'number'.",
    "error TS5058: The specified path does not exist: '/tmp/x/nope.json'.",
    "../deps/node_modules/x/index.d.ts(3,1): error TS1005: ';' expected.",
    "",
  ].join("\n");
  assert.deepStrictEqual(parseTsrs(output), [
    {
      tool: "tsrs",
      path: RelativePath.make("src/b.ts"),
      line: 1,
      column: 14,
      code: "TS2322",
      message:
        "Type '(a: number) => void' is not assignable to type '(a: string) => void'.\n  Types of parameters 'a' and 'a' are incompatible.\n    Type 'string' is not assignable to type 'number'.",
      severity: "error",
    },
    {
      tool: "tsrs",
      path: RelativePath.make("tsconfig.json"),
      line: 1,
      column: 1,
      code: "TS5058",
      message: "The specified path does not exist: '/tmp/x/nope.json'.",
      severity: "error",
    },
    {
      tool: "tsrs",
      path: RelativePath.make("tsconfig.json"),
      line: 1,
      column: 1,
      code: "TS1005",
      message: "../deps/node_modules/x/index.d.ts(3,1): ';' expected.",
      severity: "error",
    },
  ]);
});
