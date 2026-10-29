import { assert, it } from "@effect/vitest";

import { parseArgv } from "./argv.ts";

const refusal = (line: string): string => {
  try {
    parseArgv(line);
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return "accepted";
};

it("splits words on whitespace and drops the runs between them", () => {
  assert.deepStrictEqual(parseArgv("  log   --oneline\t-1\n"), ["log", "--oneline", "-1"]);
});

it("keeps single-quoted text literal, backslashes and dollars included", () => {
  assert.deepStrictEqual(parseArgv(String.raw`commit -m 'C:\dir $HOME'`), [
    "commit",
    "-m",
    String.raw`C:\dir $HOME`,
  ]);
  assert.deepStrictEqual(parseArgv(`commit -m 'a "b" | c; $(d)'`), [
    "commit",
    "-m",
    'a "b" | c; $(d)',
  ]);
});

it("unescapes only quote, backslash, dollar and backtick inside double quotes", () => {
  assert.deepStrictEqual(parseArgv(String.raw`pr create --title "say \"hi\" \$x \n"`), [
    "pr",
    "create",
    "--title",
    'say "hi" $x \\n',
  ]);
});

it("joins quoted and bare parts of one word, and keeps an empty quoted word", () => {
  assert.deepStrictEqual(parseArgv(`--title="add "'it' ""`), ["--title=add it", ""]);
});

it("takes a backslash outside quotes as an escape, and a backslash-newline as a continuation", () => {
  assert.deepStrictEqual(parseArgv("add my\\ file.ts a\\\nb"), ["add", "my file.ts", "ab"]);
});

it("refuses each shell operator outside single quotes with one-command-per-call text", () => {
  assert.deepStrictEqual(
    [
      "status | cat",
      "add . ; commit",
      "add . && push",
      "push || true",
      "log > out",
      "apply < x",
    ].map(refusal),
    [
      "ShellOperator: | is a shell operator. Run one command per call, with no shell operators.",
      "ShellOperator: ; is a shell operator. Run one command per call, with no shell operators.",
      "ShellOperator: && is a shell operator. Run one command per call, with no shell operators.",
      "ShellOperator: || is a shell operator. Run one command per call, with no shell operators.",
      "ShellOperator: > is a shell operator. Run one command per call, with no shell operators.",
      "ShellOperator: < is a shell operator. Run one command per call, with no shell operators.",
    ],
  );
});

it("refuses command substitution, bare and inside double quotes", () => {
  assert.deepStrictEqual(
    ["commit -m `date`", 'commit -m "$(date)"', "show $(cat ref)"].map(refusal),
    [
      "ShellOperator: ` is a shell operator. Run one command per call, with no shell operators.",
      "ShellOperator: $( is a shell operator. Run one command per call, with no shell operators.",
      "ShellOperator: $( is a shell operator. Run one command per call, with no shell operators.",
    ],
  );
});

it("refuses an unclosed quote", () => {
  assert.deepStrictEqual(["commit -m 'oops", 'commit -m "oops'].map(refusal), [
    "UnclosedQuote: The command has an unclosed single quote.",
    "UnclosedQuote: The command has an unclosed double quote.",
  ]);
});
