import { assert, it } from "@effect/vitest";

import { outsideModules } from "./moduleSpecifiers.ts";

const at = (text: string) =>
  outsideModules("src/deep/a.ts", text).map(({ line, column, specifier }) => [
    line,
    column,
    specifier,
  ]);

it("finds every module specifier that can resolve outside the repo, wherever TypeScript reads one", () => {
  const text = [
    'import { a } from "/Users/op/secret";',
    "import type { B } from '../../../outside';",
    'export * from "../../ok";',
    'import "C:/x";',
    'const c = await import(/* why */ "/etc/c");',
    "const d = require(`/etc/d`);",
    'import e = require("pkg/../../e");',
    'type F = typeof import("file:///etc/f");',
    '/// <reference path="/etc/g.d.ts" />',
    '/// <reference types="../../../h" />',
    "/** @jsxImportSource /etc/i */",
    'const j = \\u0069mport("/etc/j");',
    'export { k } from\n  "/etc/k";',
    'import l from "./sibling";',
    'import m from "node:fs";',
    'import n from "\\x2fetc/n";',
    'const message = "from here";',
    '/// <reference PATH="/etc/o" />',
    "// @jsxImportSource *../../../../p",
  ].join("\n");
  assert.deepStrictEqual(at(text), [
    [1, 20, "/Users/op/secret"],
    [2, 25, "../../../outside"],
    [4, 9, "C:/x"],
    [5, 35, "/etc/c"],
    [6, 20, "/etc/d"],
    [7, 21, "pkg/../../e"],
    [8, 25, "file:///etc/f"],
    [9, 22, "/etc/g.d.ts"],
    [10, 23, "../../../h"],
    [11, 22, "/etc/i"],
    [12, 24, "/etc/j"],
    [14, 4, "/etc/k"],
    [17, 16, "\\x2fetc/n"],
    [19, 22, "/etc/o"],
    [20, 21, "*../../../../p"],
  ]);
});
