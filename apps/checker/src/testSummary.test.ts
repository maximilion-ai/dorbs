import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { testCounts } from "./testSummary.ts";

const fixture = (name: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures", `${name}.txt`), "utf8");

it("counts vitest's, jest's, node --test's and bun's summaries", () => {
  assert.deepStrictEqual(
    testCounts(
      " Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 5 passed | 1 skipped (7)\n",
    ),
    { passed: 5, failed: 1, skipped: 1 },
  );
  assert.deepStrictEqual(testCounts("      Tests  4 passed (4)\n"), {
    passed: 4,
    failed: 0,
    skipped: 0,
  });
  assert.deepStrictEqual(testCounts("Tests:       1 failed, 1 skipped, 5 passed, 7 total\n"), {
    passed: 5,
    failed: 1,
    skipped: 1,
  });
  assert.deepStrictEqual(
    testCounts("ℹ tests 3\nℹ suites 0\nℹ pass 1\nℹ fail 1\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n"),
    { passed: 1, failed: 1, skipped: 1 },
  );
  assert.deepStrictEqual(testCounts("# tests 2\n# pass 2\n# fail 0\n# skipped 0\n"), {
    passed: 2,
    failed: 0,
    skipped: 0,
  });
  assert.deepStrictEqual(testCounts(" 5 pass\n 1 skip\n 1 fail\n 9 expect() calls\n"), {
    passed: 5,
    failed: 1,
    skipped: 1,
  });
});

it("counts pytest's summary line", () => {
  assert.deepStrictEqual(testCounts(fixture("pytest.stdout")), {
    passed: 1,
    failed: 1,
    skipped: 1,
  });
  assert.deepStrictEqual(testCounts("==== 3 passed, 1 error in 0.2s ====\n"), {
    passed: 3,
    failed: 1,
    skipped: 0,
  });
});

it("adds up cargo's test results across its test binaries", () => {
  const two = `${fixture("cargo-test.stdout")}\ntest result: ok. 4 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out\n`;
  assert.deepStrictEqual(testCounts(two), { passed: 5, failed: 1, skipped: 3 });
});

it("counts go test -v's top-level results, not its subtests", () => {
  assert.deepStrictEqual(testCounts(fixture("go-test.stdout")), {
    passed: 2,
    failed: 1,
    skipped: 1,
  });
});

it("finds no counts in output without a summary", () => {
  assert.strictEqual(testCounts("Error: Cannot find module 'vitest'\n"), undefined);
});
