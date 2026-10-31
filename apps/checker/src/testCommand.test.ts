import { assert, it } from "@effect/vitest";

import { RelativePath } from "@dorbs/protocol/typecheck";

import type { TestCommand } from "./Recipe.ts";
import { testCommands } from "./testCommand.ts";

const VITEST: TestCommand = {
  run: "pnpm exec vitest run",
  cwd: ".",
  target: "files",
  filterFlag: "-t",
};

it("appends the files and the filter, quoted for the shell", () => {
  assert.deepStrictEqual(
    testCommands(
      VITEST,
      { files: ["test/a b.test.ts", "test/it's.test.ts"], filter: "adds $x" },
      [],
    ),
    [
      {
        run: "pnpm exec vitest run 'test/a b.test.ts' 'test/it'\\''s.test.ts' -t 'adds $x'",
        cwd: ".",
      },
    ],
  );
  assert.deepStrictEqual(testCommands(VITEST, {}, []), [{ run: "pnpm exec vitest run", cwd: "." }]);
});

it("passes pytest ids through and cargo's filter positionally", () => {
  const pytest: TestCommand = { run: "pytest -q", cwd: ".", target: "files", filterFlag: "-k" };
  assert.deepStrictEqual(testCommands(pytest, { files: ["tests/test_a.py::test_b"] }, []), [
    { run: "pytest -q 'tests/test_a.py::test_b'", cwd: "." },
  ]);
  const cargo: TestCommand = { run: "cargo test", cwd: ".", target: "filter", filterFlag: "" };
  assert.deepStrictEqual(testCommands(cargo, { filter: "routing::nest" }, []), [
    { run: "cargo test 'routing::nest'", cwd: "." },
  ]);
  assert.deepStrictEqual(testCommands(cargo, { files: ["src/lib.rs"] }, []), {
    reason: "This repo's test command takes a name filter, not files. Pass filter instead.",
  });
});

it("tests the Go packages of the files, or every package", () => {
  const go: TestCommand = { run: "go test -v", cwd: ".", target: "packages", filterFlag: "-run" };
  assert.deepStrictEqual(
    testCommands(
      go,
      { files: ["pkg/cmd/pr/pr_test.go", "pkg/cmd/pr/view.go", "main_test.go"], filter: "TestPR" },
      [],
    ),
    [{ run: "go test -v './pkg/cmd/pr' '.' -run 'TestPR'", cwd: "." }],
  );
  assert.deepStrictEqual(testCommands(go, {}, []), [{ run: "go test -v './...'", cwd: "." }]);
});

it("runs a workspace's tests once per package, with files relative to it", () => {
  const npm: TestCommand = {
    run: "npm test -w {dir} --",
    cwd: ".",
    target: "workspace",
    filterFlag: undefined,
  };
  const dirs = [".", "apps/web", "packages/core"];
  assert.deepStrictEqual(
    testCommands(
      npm,
      { files: ["apps/web/src/a.test.ts", "packages/core/b.test.ts", "apps/web/c.test.ts"] },
      dirs,
    ),
    [
      { run: "npm test -w 'apps/web' -- 'src/a.test.ts' 'c.test.ts'", cwd: "." },
      { run: "npm test -w 'packages/core' -- 'b.test.ts'", cwd: "." },
    ],
  );
  assert.deepStrictEqual(testCommands(npm, { files: ["scripts/x.test.ts"] }, dirs), {
    reason: "scripts/x.test.ts is in no workspace package.",
  });
  assert.deepStrictEqual(testCommands(npm, {}, dirs), {
    reason: "This repo's tests run per workspace package. Pass the test files to run.",
  });
  assert.deepStrictEqual(testCommands(npm, { files: ["apps/web/a.test.ts"], filter: "x" }, dirs), {
    reason: "This repo's test command takes no name filter. Pass files instead.",
  });
});

it("refuses a file outside the repo or the test command's directory", () => {
  assert.deepStrictEqual(testCommands(VITEST, { files: ["../x.test.ts"] }, []), {
    reason: "../x.test.ts is not a path inside the repo.",
  });
  const nested: TestCommand = { ...VITEST, cwd: RelativePath.make("packages/a") };
  assert.deepStrictEqual<unknown>(testCommands(nested, { files: ["packages/a/x.test.ts"] }, []), [
    { run: "pnpm exec vitest run 'x.test.ts'", cwd: "packages/a" },
  ]);
  assert.deepStrictEqual(testCommands(nested, { files: ["b.test.ts"] }, []), {
    reason: "b.test.ts is outside packages/a, where the tests run.",
  });
});
