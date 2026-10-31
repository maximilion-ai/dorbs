// The hillclimb's task suites. Each task is one dorbs thread turn modelled on the thread study's task types
// (implementers verify with test ~30x, lint ~16x, typecheck ~10x a thread; reviewers and researchers read only).
// The sandbox suite runs today; the real suite waits on the GitHub App reaching its repos.

export type Suite = "sandbox" | "real";

export type FileExpectation = {
  readonly path: string;
  /** Every pattern must match the file as the follow-up probe reads it. */
  readonly matches: ReadonlyArray<RegExp>;
};

export type Expect = {
  /** Tools whose last call in the turn must be green and come after the turn's last write. */
  readonly verified: ReadonlyArray<"check" | "test">;
  /** The fewest passing tests the last green test call must report. */
  readonly minTests: number;
  readonly files: ReadonlyArray<FileExpectation>;
  /** A commit beyond the base on the run's branch, with a clean tree. */
  readonly commit: boolean;
  /** No write_file or edit_file call. */
  readonly readOnly: boolean;
  /** Patterns the turn's reply must match. */
  readonly reply: ReadonlyArray<RegExp>;
};

export type Task = {
  readonly id: string;
  readonly suite: Suite;
  /** Repo id as clone_repo takes it. */
  readonly repo: string;
  /** The commit clone_repo must report; a run that clones another commit is invalid, not failed. */
  readonly base: string;
  readonly type: "feature" | "bugfix" | "refactor" | "test" | "docs" | "research" | "review";
  readonly difficulty: "easy" | "hard";
  readonly prompt: (branch: string) => string;
  readonly expect: Expect;
};

const SANDBOX = "maximilionai/dorbs-sandbox";
const SANDBOX_BASE = "f8fecadcf77c0bb386db3ec889d6eb362d067683";

const commitOnly = (branch: string) =>
  `Commit your work on a new local branch ${branch}. Do not push and do not open a pull request. ` +
  "Reply with one sentence when done.";

const readOnly = "Do not change, commit or push anything.";

const NONE: Expect = {
  verified: [],
  minTests: 0,
  files: [],
  commit: false,
  readOnly: false,
  reply: [],
};

const implement = (expect: Partial<Expect>): Expect => ({
  ...NONE,
  verified: ["check", "test"],
  minTests: 1,
  commit: true,
  ...expect,
});

const study = (expect: Partial<Expect>): Expect => ({ ...NONE, readOnly: true, ...expect });

const sandbox = (task: Omit<Task, "suite" | "repo" | "base">): Task => ({
  ...task,
  suite: "sandbox",
  repo: SANDBOX,
  base: SANDBOX_BASE,
});

// The sandbox holds package.json, tsconfig.json (strict), src/index.ts and README.md. The checker runs tsc as
// its typecheck and `node --test` as its test command, so tests are node:test files in TypeScript.
const NODE_TEST =
  "Write tests with node:test and node:assert/strict in .test.ts files next to the code.";

export const SANDBOX_TASKS: ReadonlyArray<Task> = [
  sandbox({
    id: "sb-survey",
    type: "research",
    difficulty: "easy",
    prompt: () =>
      `Clone ${SANDBOX}. Describe what the repo is in two sentences and list all its files. ${readOnly}`,
    expect: study({
      reply: [/README\.md/u, /src\/index\.ts/u, /tsconfig\.json/u, /package\.json/u],
    }),
  }),
  sandbox({
    id: "sb-review",
    type: "review",
    difficulty: "easy",
    prompt: () =>
      `Clone ${SANDBOX} and review its latest commit: what it changes and one concrete risk or ` +
      `improvement. Run the repo's checks and tests before you answer. ${readOnly}`,
    expect: study({ verified: ["check"], reply: [/greeting|index\.ts/u] }),
  }),
  sandbox({
    id: "sb-docs",
    type: "docs",
    difficulty: "easy",
    prompt: (branch) =>
      `Clone ${SANDBOX}. Add a "## Development" section to README.md that says the repo is checked with ` +
      `tsc in strict mode and tested with node --test. ${commitOnly(branch)}`,
    expect: {
      ...NONE,
      commit: true,
      files: [{ path: "README.md", matches: [/## Development/u, /node --test/u] }],
    },
  }),
  sandbox({
    id: "sb-sum",
    type: "feature",
    difficulty: "easy",
    prompt: (branch) =>
      `Clone ${SANDBOX}. Add src/sum.ts exporting sum(xs: number[]): number, the sum of xs (0 for none), ` +
      `with tests. ${NODE_TEST} Make the checks and tests pass. ${commitOnly(branch)}`,
    expect: implement({
      files: [
        { path: "src/sum.ts", matches: [/export (function|const) sum\b/u] },
        { path: "src/sum.test.ts", matches: [/node:test/u] },
      ],
    }),
  }),
  sandbox({
    id: "sb-greet-test",
    type: "test",
    difficulty: "easy",
    prompt: (branch) =>
      `Clone ${SANDBOX}. Add tests for src/index.ts that pin the value of greeting. ${NODE_TEST} ` +
      `Make the checks and tests pass. ${commitOnly(branch)}`,
    expect: implement({ files: [{ path: "src/index.test.ts", matches: [/greeting/u] }] }),
  }),
  sandbox({
    id: "sb-refactor",
    type: "refactor",
    difficulty: "hard",
    prompt: (branch) =>
      `Clone ${SANDBOX}. Rename the export greeting in src/index.ts to defaultGreeting, and add ` +
      "greet(name?: string): string that returns `${defaultGreeting}, ${name}` or defaultGreeting alone " +
      `when name is missing or blank. Keep every reference compiling. ${NODE_TEST} ` +
      `Cover greet's cases. Make the checks and tests pass. ${commitOnly(branch)}`,
    expect: implement({
      minTests: 2,
      files: [
        { path: "src/index.ts", matches: [/export const defaultGreeting\b/u, /greet\b/u] },
        { path: "src/index.test.ts", matches: [/greet\(/u] },
      ],
    }),
  }),
  sandbox({
    id: "sb-chunk-bug",
    type: "bugfix",
    difficulty: "hard",
    prompt: (branch) =>
      `Clone ${SANDBOX}. Add src/chunk.ts with exactly this code:\n\n` +
      "```ts\nexport function chunk<T>(xs: readonly T[], size: number): T[][] {\n" +
      "  const out: T[][] = [];\n  for (let i = 0; i + size <= xs.length; i += size) out.push(xs.slice(i, i + size));\n" +
      "  return out;\n}\n```\n\n" +
      "Users report that chunk([1, 2, 3, 4, 5], 2) loses the 5. Write a test that fails on this bug, then fix " +
      `chunk so it keeps the last partial chunk and throws a RangeError for a size below 1. ${NODE_TEST} ` +
      `Make the checks and tests pass. ${commitOnly(branch)}`,
    expect: implement({
      minTests: 2,
      files: [
        { path: "src/chunk.ts", matches: [/export function chunk/u, /RangeError/u] },
        { path: "src/chunk.test.ts", matches: [/\[\s*5\s*\]/u] },
      ],
    }),
  }),
  sandbox({
    id: "sb-money",
    type: "feature",
    difficulty: "hard",
    prompt: (branch) =>
      `Clone ${SANDBOX}. Add src/money.ts: a Money type { cents: number; currency: string }, ` +
      'parseMoney(text: string): Money | undefined that reads strings like "12.34 EUR" or "-0.5 USD" ' +
      "(at most two decimals, a three-letter uppercase currency, undefined for anything else), " +
      "formatMoney(m: Money): string that prints them back with two decimals, and addMoney(a: Money, " +
      "b: Money): Money that throws on a currency mismatch. No any. Cover the edge cases with tests. " +
      `${NODE_TEST} Make the checks and tests pass. ${commitOnly(branch)}`,
    expect: implement({
      minTests: 4,
      files: [
        { path: "src/money.ts", matches: [/parseMoney/u, /formatMoney/u, /addMoney/u] },
        { path: "src/money.test.ts", matches: [/parseMoney/u] },
      ],
    }),
  }),
  sandbox({
    id: "sb-config",
    type: "feature",
    difficulty: "hard",
    prompt: (branch) =>
      `Clone ${SANDBOX}. Add src/config.ts exporting parseConfig(env: Record<string, string | undefined>) ` +
      "that returns { ok: true, config: { port: number; debug: boolean; name: string } } or " +
      "{ ok: false, errors: string[] }. PORT is required and must be an integer from 1 to 65535; DEBUG is " +
      'optional, "true" or "false", default false; NAME defaults to "dorbs". Collect every error rather than ' +
      `stopping at the first. No any. ${NODE_TEST} Make the checks and tests pass. ${commitOnly(branch)}`,
    expect: implement({
      minTests: 3,
      files: [
        { path: "src/config.ts", matches: [/export (function|const) parseConfig\b/u] },
        { path: "src/config.test.ts", matches: [/parseConfig/u] },
      ],
    }),
  }),
  sandbox({
    id: "sb-events",
    type: "feature",
    difficulty: "hard",
    prompt: (branch) =>
      `Clone ${SANDBOX}. Add src/events.ts exporting createEmitter<Events extends Record<string, unknown>>() ` +
      "returning { on, off, emit }, where on(name, listener) returns an unsubscribe function and both " +
      "listener payloads and emit's payload are typed by the Events map. A listener that throws must not " +
      `stop the others. No any. ${NODE_TEST} Make the checks and tests pass. ${commitOnly(branch)}`,
    expect: implement({
      minTests: 3,
      files: [
        { path: "src/events.ts", matches: [/export (function|const) createEmitter\b/u] },
        { path: "src/events.test.ts", matches: [/createEmitter/u] },
      ],
    }),
  }),
];

const real = (repo: string, base: string, task: Omit<Task, "suite" | "repo" | "base">): Task => ({
  ...task,
  suite: "real",
  repo,
  base,
});

// Pinned to each default branch's head on 2026-10-31; clone_repo clones the default branch, so a moved head
// marks the run invalid until the pin is bumped. dorbs' main holds only its README, so the dorbs tasks pin
// feat/isolate-agents and stay invalid until it lands on main.
const DORBS = (task: Omit<Task, "suite" | "repo" | "base">) =>
  real("maximilionai/dorbs", "4282f5c53e5194de38fd196ca38258a72e9de92b", task);
const GARTEN = (task: Omit<Task, "suite" | "repo" | "base">) =>
  real("maximilion-ai/garten", "9bfcd53d86857578eef14d625cdec5c2e8c68008", task);
const FAKTS = (task: Omit<Task, "suite" | "repo" | "base">) =>
  real("Fakts-org/fakts", "c80729a6a16285645c0a8723a7481f6f925da88d", task);

const REAL_TASKS: ReadonlyArray<Task> = [
  FAKTS({
    id: "fakts-base64-test",
    type: "test",
    difficulty: "easy",
    prompt: (branch) =>
      "Clone Fakts-org/fakts. packages/domain/src/base64.ts has no tests. Add " +
      "packages/domain/src/base64.test.ts with vitest covering a round trip of all 256 byte values and the " +
      `empty input. Run that test file and the checks until both pass. ${commitOnly(branch)}`,
    expect: implement({
      minTests: 2,
      files: [
        {
          path: "packages/domain/src/base64.test.ts",
          matches: [/base64ToBytes/u, /bytesToBase64/u],
        },
      ],
    }),
  }),
  FAKTS({
    id: "fakts-from-hex",
    type: "feature",
    difficulty: "hard",
    prompt: (branch) =>
      "Clone Fakts-org/fakts. Add fromHex(hex: string): Uint8Array to packages/domain/src/hex.ts, the " +
      "inverse of toHex. It accepts upper and lower case and throws on odd length or a non-hex character. " +
      "Extend packages/domain/src/hex.test.ts to cover it. Run that test file and the checks until both " +
      `pass. ${commitOnly(branch)}`,
    expect: implement({
      minTests: 3,
      files: [
        { path: "packages/domain/src/hex.ts", matches: [/export function fromHex\b/u] },
        { path: "packages/domain/src/hex.test.ts", matches: [/fromHex/u] },
      ],
    }),
  }),
  FAKTS({
    id: "fakts-idempotency-research",
    type: "research",
    difficulty: "easy",
    prompt: () =>
      "Clone Fakts-org/fakts. Explain how packages/domain/src/idempotency.ts derives its ids, which " +
      `functions use a hash and which do not, in at most six sentences. ${readOnly}`,
    expect: study({ reply: [/derivePhaseId/u, /deriveBatchId/u] }),
  }),
  GARTEN({
    id: "garten-seq-test",
    type: "test",
    difficulty: "easy",
    prompt: (branch) =>
      "Clone maximilion-ai/garten. apps/agent/src/seq.ts brands positive integers as Seq. Add " +
      "apps/agent/test/seq.test.ts with vitest showing that Seq accepts 1 and rejects 0, -1 and 1.5. " +
      `Run that test file and the agent's checks until both pass. ${commitOnly(branch)}`,
    expect: implement({
      minTests: 2,
      files: [{ path: "apps/agent/test/seq.test.ts", matches: [/Seq/u] }],
    }),
  }),
  GARTEN({
    id: "garten-proposal-place",
    type: "test",
    difficulty: "hard",
    prompt: (branch) =>
      "Clone maximilion-ai/garten. Read apps/agent/src/rules.ts and add tests to apps/agent/test/rules.test.ts " +
      "for proposalPlace covering an owner's item and a non-owner's item. Run that test file and the " +
      `agent's checks until both pass. ${commitOnly(branch)}`,
    expect: implement({
      minTests: 2,
      files: [{ path: "apps/agent/test/rules.test.ts", matches: [/proposalPlace/u] }],
    }),
  }),
  GARTEN({
    id: "garten-rules-research",
    type: "research",
    difficulty: "easy",
    prompt: () =>
      "Clone maximilion-ai/garten. Explain how a rule proposal becomes a stored rule in apps/agent/src/rules.ts, " +
      `naming the types and methods involved, in at most eight sentences. ${readOnly}`,
    expect: study({ reply: [/Proposal/u, /Confirm/u] }),
  }),
  DORBS({
    id: "dorbs-argv-test",
    type: "test",
    difficulty: "easy",
    prompt: (branch) =>
      "Clone maximilionai/dorbs. Add a case to apps/agent-worker/src/argv.test.ts showing that parseArgv " +
      "refuses a backtick outside single quotes and keeps one inside them. Run that test file and the " +
      `checks until both pass. ${commitOnly(branch)}`,
    expect: implement({ files: [{ path: "apps/agent-worker/src/argv.test.ts", matches: [/`/u] }] }),
  }),
  DORBS({
    id: "dorbs-tool-end-test",
    type: "test",
    difficulty: "hard",
    prompt: (branch) =>
      "Clone maximilionai/dorbs. In apps/agent-worker/src/updates.test.ts, add a test that toolCallEnd for a " +
      "failed call with two texts and no details yields a failed tool_call_update with two text contents and " +
      `no diff. Run that test file and the checks until both pass. ${commitOnly(branch)}`,
    expect: implement({
      files: [{ path: "apps/agent-worker/src/updates.test.ts", matches: [/toolCallEnd/u] }],
    }),
  }),
  DORBS({
    id: "dorbs-survey",
    type: "research",
    difficulty: "easy",
    prompt: () =>
      "Clone maximilionai/dorbs. List the tools the agent Worker offers the model, from " +
      `apps/agent-worker/src/tools.ts, with one line each on what it does. ${readOnly}`,
    expect: study({ reply: [/clone_repo/u, /edit_file/u, /check/u, /gh/u] }),
  }),
  DORBS({
    id: "dorbs-git-docs",
    type: "docs",
    difficulty: "easy",
    prompt: (branch) =>
      "Clone maximilionai/dorbs. Add a short section to README.md that lists the git subcommands the agent " +
      `refuses and why, from apps/agent-worker/src/git.ts. ${commitOnly(branch)}`,
    expect: {
      ...NONE,
      commit: true,
      files: [{ path: "README.md", matches: [/fetch/u, /remote/u] }],
    },
  }),
];

export const suite = (name: Suite): ReadonlyArray<Task> =>
  name === "sandbox" ? SANDBOX_TASKS : REAL_TASKS;
