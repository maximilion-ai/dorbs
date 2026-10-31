import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import type { Diagnostic } from "@dorbs/protocol/checker";

import { type ParseContext, parseOutput } from "./diagnostics.ts";

const fixture = (name: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures", `${name}.txt`), "utf8");

const CONTEXT: ParseContext = { root: "/env/repo", cwd: ".", source: "check", packages: new Map() };

/** A diagnostic as a short line, so a test reads the whole set at a glance. */
const brief = (d: Diagnostic) =>
  `${d.path}:${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character} ${d.severity} ${d.source}${d.code === undefined ? "" : ` ${d.code}`} ${d.message}`;

const parse = (
  format: Parameters<typeof parseOutput>[0],
  stdout: string,
  stderr = "",
  context: Partial<ParseContext> = {},
) => {
  const parsed = parseOutput(format, stdout, stderr, { ...CONTEXT, ...context });
  return { diagnostics: parsed.diagnostics.map(brief), output: parsed.output };
};

it("reads tsc's lines, continuation lines included, relative to the directory it ran in", () => {
  assert.deepStrictEqual(parse("text", fixture("tsc.stdout")), {
    diagnostics: [
      "src/a.ts:0:13-0:13 1 tsc TS2322 Type 'string' is not assignable to type 'number'.",
      "src/a.ts:3:11-3:11 1 tsc TS2339 Property 'foo' does not exist on type 'string'.",
    ],
    output: [],
  });
  const nested = parse(
    "text",
    "src/x.ts(2,5): error TS2345: Argument of type 'string' is not assignable.\n  Type 'string' is not 'number'.\nerror TS5102: Option 'baseUrl' has been removed.\n",
    "",
    { cwd: "packages/core" },
  );
  assert.deepStrictEqual(nested.diagnostics, [
    "packages/core/src/x.ts:1:4-1:4 1 tsc TS2345 Argument of type 'string' is not assignable.\n  Type 'string' is not 'number'.",
  ]);
  assert.deepStrictEqual(nested.output, ["error TS5102: Option 'baseUrl' has been removed."]);
});

it("resolves paths under pnpm -r and turbo prefixes to the package they ran in", () => {
  const parsed = parse(
    "text",
    [
      "packages/core typecheck: src/a.ts(1,2): error TS2322: Bad.",
      "@vben/web:typecheck: src/b.vue(3,4): error TS2304: Cannot find name 'x'.",
      "packages/core typecheck: Done",
    ].join("\n"),
    "",
    { packages: new Map([["@vben/web", "apps/web"]]) },
  );
  assert.deepStrictEqual(parsed, {
    diagnostics: [
      "packages/core/src/a.ts:0:1-0:1 1 tsc TS2322 Bad.",
      "apps/web/src/b.vue:2:3-2:3 1 tsc TS2304 Cannot find name 'x'.",
    ],
    output: ["packages/core typecheck: Done"],
  });
});

it("reads eslint's JSON and its stylish text alike", () => {
  const expected = [
    "src/c.js:0:6-0:7 1 eslint no-unused-vars 'a' is assigned a value but never used.",
    "src/c.js:1:0-1:9 1 eslint no-debugger Unexpected 'debugger' statement.",
    "src/c.js:2:0-2:3 1 eslint no-undef 'foo' is not defined.",
  ];
  assert.deepStrictEqual(parse("eslint-json", fixture("eslint-json.stdout")), {
    diagnostics: expected,
    output: [],
  });
  const stylish = parse("text", fixture("eslint-stylish.stdout"));
  assert.deepStrictEqual(stylish.diagnostics, [
    "src/c.js:0:6-0:6 1 eslint no-unused-vars 'a' is assigned a value but never used",
    "src/c.js:1:0-1:0 1 eslint no-debugger Unexpected 'debugger' statement",
    "src/c.js:2:0-2:0 1 eslint no-undef 'foo' is not defined",
  ]);
  assert.deepStrictEqual(stylish.output, ["✖ 3 problems (3 errors, 0 warnings)"]);
});

it("reads oxlint's JSON, a parse error without a label included", () => {
  assert.deepStrictEqual(parse("oxlint-json", fixture("oxlint-json.stdout")), {
    diagnostics: [
      "src/b.ts:0:0-0:0 2 oxlint eslint(no-debugger) `debugger` statement is not allowed",
      "src/a.ts:1:6-1:6 2 oxlint eslint(no-unused-vars) Variable 'unused' is declared but never used. Unused variables should start with a '_'.",
      "src/d.ts:0:0-0:0 1 oxlint Parsing error",
    ],
    output: [],
  });
});

it("reads biome's GitHub annotations and keeps its banner as output", () => {
  const parsed = parse("text", fixture("biome-github.stdout"), fixture("biome-github.stderr"));
  assert.deepStrictEqual(parsed.diagnostics, [
    "src/App.svelte:1:6-1:7 2 biome lint/correctness/noUnusedVariables This variable x is unused.",
    "src/a.ts:1:6-1:12 2 biome lint/correctness/noUnusedVariables This variable unused is unused.",
    "src/c.js:0:6-0:7 2 biome lint/correctness/noUnusedVariables This variable a is unused.",
    "src/b.ts:0:0-0:9 1 biome lint/suspicious/noDebugger This is an unexpected use of the debugger statement.",
    "src/c.js:1:0-1:9 1 biome lint/suspicious/noDebugger This is an unexpected use of the debugger statement.",
  ]);
  assert.deepStrictEqual(parsed.output, [
    fixture("biome-github.stderr").split("\n")[0] ?? "",
    "× Some errors were emitted while running checks.",
  ]);
});

it("turns each file prettier --check names into a diagnostic", () => {
  assert.deepStrictEqual(parse("text", fixture("prettier.stdout"), fixture("prettier.stderr")), {
    diagnostics: [
      "src/b.ts:0:0-0:0 2 prettier The file is not formatted as Prettier would format it.",
    ],
    output: [
      "Checking formatting...",
      "[warn] Code style issues found in the above file. Run Prettier with --write to fix.",
    ],
  });
});

it("reads svelte-check's machine and human output to the same diagnostics", () => {
  const expected = [
    "node_modules/esrap/types/types.d.ts:0:29-0:29 1 svelte-check Cannot find module 'esrap' or its corresponding type declarations.",
    "node_modules/svelte/types/index.d.ts:859:36-859:36 1 svelte-check Cannot find module 'esrap/languages/ts' or its corresponding type declarations.",
    "src/App.svelte:1:6-1:6 1 svelte-check Type 'string' is not assignable to type 'number'.",
    "src/a.ts:0:13-0:13 1 svelte-check Type 'string' is not assignable to type 'number'.",
    "src/a.ts:3:11-3:11 1 svelte-check Property 'foo' does not exist on type 'string'.",
    "tsconfig.json:0:2-0:2 2 svelte-check Option 'moduleResolution' must be set to 'NodeNext' (or left unspecified) when option 'module' is set to 'NodeNext'.",
  ];
  const machine = parse("text", fixture("svelte-machine.stdout"));
  assert.deepStrictEqual(machine.diagnostics, expected);
  assert.strictEqual(machine.output.length, 2);
  const human = parse("text", fixture("svelte-human.stdout"));
  assert.deepStrictEqual(human.diagnostics, expected);
  assert.deepStrictEqual(human.output, [
    "====================================",
    "svelte-check found 5 errors and 1 warning in 5 files",
  ]);
});

it("reads pyright's and ruff's JSON, and mypy's lines", () => {
  assert.deepStrictEqual(parse("pyright-json", fixture("pyright-json.stdout")).diagnostics, [
    'pkg/a.py:0:9-0:12 1 pyright reportAssignmentType Type "Literal[\'a\']" is not assignable to declared type "int"\n  "Literal[\'a\']" is not assignable to "int"',
    'pkg/a.py:1:7-1:9 2 pyright Import "os" is not accessed',
  ]);
  assert.deepStrictEqual(parse("ruff-json", fixture("ruff-json.stdout")).diagnostics, [
    "pkg/a.py:1:0-1:9 1 ruff I001 Import block is un-sorted or un-formatted",
    "pkg/a.py:1:7-1:9 1 ruff F401 `os` imported but unused",
  ]);
  assert.deepStrictEqual(parse("text", fixture("mypy.stdout"), "", { source: "mypy" }), {
    diagnostics: [
      'pkg/a.py:0:0-0:0 1 mypy assignment Incompatible types in assignment (expression has type "str", variable has type "int")',
      'pkg/a.py:4:0-4:0 1 mypy return-value Incompatible return value type (got "int", expected "str")',
    ],
    output: ["Found 2 errors in 1 file (checked 1 source file)"],
  });
});

it("reads cargo's JSON messages once each and keeps its notes as output", () => {
  assert.deepStrictEqual(
    parse("cargo-json", fixture("cargo-json.stdout"), fixture("cargo-json.stderr")),
    {
      diagnostics: [
        "src/lib.rs:0:19-0:22 1 rustc E0308 mismatched types: expected `u32`, found `&str`",
      ],
      output: [
        "For more information about this error, try `rustc --explain E0308`.",
        "Checking repo v0.1.0 (/env/repo)",
        "error: could not compile `repo` (lib) due to 1 previous error",
        "warning: build failed, waiting for other jobs to finish...",
        "error: could not compile `repo` (lib test) due to 1 previous error",
      ],
    },
  );
});

it("reads go build's lines and go vet's JSON, build errors under vet included", () => {
  assert.deepStrictEqual(parse("text", "", fixture("go-build.stderr"), { source: "go-build" }), {
    diagnostics: [
      'pkg/a/b.go:2:12-2:12 1 go-build cannot use "x" (untyped string constant) as int value in variable declaration',
    ],
    output: ["# example.com/w/pkg/a"],
  });
  assert.deepStrictEqual(parse("go-vet-json", fixture("go-vet.stdout"), "", { source: "go-vet" }), {
    diagnostics: [
      'pkg/a/a.go:4:23-4:25 2 go-vet printf fmt.Printf format %d has arg "x" of wrong type string',
    ],
    output: [],
  });
  assert.deepStrictEqual(
    parse("go-vet-json", "", fixture("go-vet-build-error.stderr"), { source: "go-vet" })
      .diagnostics,
    [
      'pkg/a/b.go:2:12-2:12 1 go-vet cannot use "x" (untyped string constant) as int value in variable declaration',
    ],
  );
});

it("keeps a line about a file outside the repo as output, never as a diagnostic", () => {
  assert.deepStrictEqual(
    parse(
      "text",
      "/home/agent/.ssh/id_rsa(1,1): error TS1005: secret\n../../etc/passwd:1:1: oops\n",
    ),
    {
      diagnostics: [],
      output: ["/home/agent/.ssh/id_rsa(1,1): error TS1005: secret", "../../etc/passwd:1:1: oops"],
    },
  );
});

it("keeps JSON it cannot read as output lines", () => {
  assert.deepStrictEqual(
    parse("eslint-json", "Oops! Something went wrong!\n", "ESLint: 10.14.0\n"),
    {
      diagnostics: [],
      output: ["Oops! Something went wrong!", "ESLint: 10.14.0"],
    },
  );
});

it("reads pyright's and basedpyright's human output", () => {
  assert.deepStrictEqual(
    parse(
      "text",
      [
        "/env/repo/searx/webapp.py",
        '  /env/repo/searx/webapp.py:10:5 - error: "x" is not defined (reportUndefinedVariable)',
        "  /env/repo/searx/webapp.py:12:1 - warning: Import cycle",
        "2 errors, 1 warning, 0 notes",
      ].join("\n"),
    ),
    {
      diagnostics: [
        'searx/webapp.py:9:4-9:4 1 pyright reportUndefinedVariable "x" is not defined',
        "searx/webapp.py:11:0-11:0 2 pyright Import cycle",
      ],
      output: ["/env/repo/searx/webapp.py", "2 errors, 1 warning, 0 notes"],
    },
  );
});

it("reads two-line formats under pnpm's prefixes, with packages' lines interleaved", () => {
  const parsed = parse(
    "text",
    [
      "docs check$ svelte-check --tsconfig ./tsconfig.json",
      "docs check: /env/repo/docs/src/lib/colors.ts:12:14",
      "packages/cli check: /env/repo/packages/cli/src/a.ts:1:1",
      "docs check: Error: Type 'string' is not assignable to type 'number'. (ts)",
      "packages/cli check: Warn: Unused import.",
      "docs check: svelte-check found 1 error and 0 warnings in 1 file",
    ].join("\n"),
    "",
    {
      packages: new Map([
        ["docs", "docs"],
        ["shadcn-svelte", "packages/cli"],
      ]),
    },
  );
  assert.deepStrictEqual(parsed, {
    diagnostics: [
      "docs/src/lib/colors.ts:11:13-11:13 1 svelte-check Type 'string' is not assignable to type 'number'.",
      "packages/cli/src/a.ts:0:0-0:0 2 svelte-check Unused import.",
    ],
    output: [
      "docs check$ svelte-check --tsconfig ./tsconfig.json",
      "docs check: svelte-check found 1 error and 0 warnings in 1 file",
    ],
  });
});
