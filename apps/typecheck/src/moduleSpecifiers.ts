import { specifierLeavesRepo } from "./repoPaths.ts";

// A keyword as TypeScript reads it: each letter may be spelled as a \u escape.
const keyword = (word: string): string =>
  word
    .split("")
    .map((letter) => {
      const hex = letter.charCodeAt(0).toString(16).padStart(4, "0");
      return String.raw`(?:${letter}|\\u${hex}|\\u\{0*${hex.replace(/^0+/, "")}\})`;
    })
    .join("");

// Whitespace and comments, which may sit between any two tokens.
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*`;
// A quoted string as two groups, the quote and the text; `group` numbers the quote's group.
const quoted = (group: number) => `(["'\`])((?:(?!\\${group})[^\\\\\\n]|\\\\[\\s\\S])*)\\${group}`;
const BEFORE = String.raw`(?<![\w$\\])`;

// Over-matching is safe here: a false hit only refuses a check, a miss could leak a file.
const SPECIFIER = new RegExp(
  [
    // import "x", import("x"), from "x", require("x"), and import("x") in a type.
    String.raw`${BEFORE}(?:${keyword("import")}|${keyword("from")}|${keyword("require")})${GAP}\(?${GAP}${quoted(1)}`,
    // Triple-slash references by path or by types.
    String.raw`\/\/\/${GAP}<reference\b[^>\n]*?\b(?:path|types)\s*=\s*${quoted(3)}`,
    // The @jsxImportSource pragma, which names the module the JSX runtime loads from.
    String.raw`@jsxImportSource\s+()([^\s*]+)`,
  ].join("|"),
  "g",
);

export type OutsideModule = {
  readonly line: number;
  readonly column: number;
  readonly specifier: string;
};

/**
 * The module specifiers in `text`, the content of the repo file `path`, that can resolve outside
 * the repo, with the 1-based line and column where each starts.
 */
export const outsideModules = (path: string, text: string): ReadonlyArray<OutsideModule> => {
  const found: Array<OutsideModule> = [];
  for (const match of text.matchAll(SPECIFIER)) {
    const groups = match.slice(1);
    const index = groups.findLastIndex((group) => group !== undefined);
    const specifier = groups[index] ?? "";
    if (!specifierLeavesRepo(path, specifier)) continue;
    const start = match.index + match[0].lastIndexOf(specifier);
    const before = text.slice(0, start);
    found.push({
      line: before.split("\n").length,
      column: start - before.lastIndexOf("\n"),
      specifier,
    });
  }
  return found;
};
