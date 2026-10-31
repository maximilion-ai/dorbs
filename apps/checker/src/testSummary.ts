export type TestCounts = {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
};

const count = (text: string, pattern: RegExp): number | undefined => {
  const match = pattern.exec(text);
  return match === null ? undefined : Number(match[1]);
};

const sum = (text: string, pattern: RegExp): number =>
  [...text.matchAll(pattern)].reduce((total, match) => total + Number(match[1]), 0);

/** One runner's summary: a test, a pass and a fail count, found or not. */
type Reader = (output: string) => TestCounts | undefined;

// vitest: "Tests  1 failed | 5 passed | 1 skipped (7)".
const vitest: Reader = (output) => {
  const line = /^\s*Tests\s{2,}(.*\(\d+\))\s*$/m.exec(output)?.[1];
  if (line === undefined) return undefined;
  return {
    passed: count(line, /(\d+) passed/) ?? 0,
    failed: count(line, /(\d+) failed/) ?? 0,
    skipped: (count(line, /(\d+) skipped/) ?? 0) + (count(line, /(\d+) todo/) ?? 0),
  };
};

// jest: "Tests:       1 failed, 1 skipped, 5 passed, 7 total".
const jest: Reader = (output) => {
  const line = /^Tests:\s+(.*\d+ total)\s*$/m.exec(output)?.[1];
  if (line === undefined) return undefined;
  return {
    passed: count(line, /(\d+) passed/) ?? 0,
    failed: count(line, /(\d+) failed/) ?? 0,
    skipped: (count(line, /(\d+) skipped/) ?? 0) + (count(line, /(\d+) todo/) ?? 0),
  };
};

// node --test: "ℹ pass 1" with the spec reporter, "# pass 1" with tap.
const node: Reader = (output) => {
  const passed = count(output, /^[ℹ#] pass (\d+)$/m);
  if (passed === undefined) return undefined;
  return {
    passed,
    failed: count(output, /^[ℹ#] fail (\d+)$/m) ?? 0,
    skipped:
      (count(output, /^[ℹ#] skipped (\d+)$/m) ?? 0) + (count(output, /^[ℹ#] todo (\d+)$/m) ?? 0),
  };
};

// bun test: " 5 pass", " 1 fail", " 1 skip".
const bun: Reader = (output) => {
  const passed = count(output, /^\s*(\d+) pass$/m);
  if (passed === undefined) return undefined;
  return {
    passed,
    failed: count(output, /^\s*(\d+) fail$/m) ?? 0,
    skipped: (count(output, /^\s*(\d+) skip$/m) ?? 0) + (count(output, /^\s*(\d+) todo$/m) ?? 0),
  };
};

// pytest: "1 failed, 1 passed, 1 skipped in 0.01s", with or without === around it.
const pytest: Reader = (output) => {
  const line = [...output.matchAll(/^=*\s*((?:\d+ \w+(?:, )?)+) in [\d.]+s.*$/gm)].at(-1)?.[1];
  if (line === undefined) return undefined;
  return {
    passed: count(line, /(\d+) passed/) ?? 0,
    failed: (count(line, /(\d+) failed/) ?? 0) + (count(line, /(\d+) errors?/) ?? 0),
    skipped: (count(line, /(\d+) skipped/) ?? 0) + (count(line, /(\d+) xfailed/) ?? 0),
  };
};

// cargo: one "test result: FAILED. 1 passed; 1 failed; 1 ignored; ..." per test binary.
const cargo: Reader = (output) => {
  if (!/^test result: /m.test(output)) return undefined;
  return {
    passed: sum(output, /^test result: \w+\. (\d+) passed/gm),
    failed: sum(output, /^test result: \w+\. \d+ passed; (\d+) failed/gm),
    skipped: sum(output, /^test result: \w+\. \d+ passed; \d+ failed; (\d+) ignored/gm),
  };
};

// go test -v: "--- PASS: TestX" at the start of a line; subtests are indented under their parent.
const go: Reader = (output) => {
  const passed = (output.match(/^--- PASS: /gm) ?? []).length;
  const failed = (output.match(/^--- FAIL: /gm) ?? []).length;
  const skipped = (output.match(/^--- SKIP: /gm) ?? []).length;
  return passed + failed + skipped === 0 ? undefined : { passed, failed, skipped };
};

const READERS: ReadonlyArray<Reader> = [vitest, jest, node, bun, pytest, cargo, go];

/** The counts in a test runner's summary, whichever runner printed it, or undefined without one. */
export const testCounts = (output: string): TestCounts | undefined => {
  for (const read of READERS) {
    const counts = read(output);
    if (counts !== undefined) return counts;
  }
  return undefined;
};
