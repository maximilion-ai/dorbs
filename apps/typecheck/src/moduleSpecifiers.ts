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

// Case-blind, so no spelling TypeScript might accept slips past.
const IMPORT = new RegExp(
  String.raw`(?<![\w$\\])(?:${keyword("import")}|${keyword("from")}|${keyword("require")})`,
  "gi",
);
const REFERENCE = /\/\/\/[^\S\n]*<reference\b[^\n]*/gi;
const REFERENCE_PATH = /\b(?:path|types)\s*=\s*/gi;
const JSX_IMPORT_SOURCE = /@jsxImportSource[^\S\n]+/gi;
const PRAGMA_END = /\s|\*\//g;
// No real module specifier comes close; a longer one counts as outside rather than being read.
const MAX_SPECIFIER = 4096;
const TOO_LONG = "a specifier over 4096 characters";

export type OutsideModule = {
  readonly line: number;
  readonly column: number;
  readonly specifier: string;
};

/**
 * The specifiers in `text`, the repo file `path`, that can resolve outside the repo: after `import`,
 * `from` or `require`, in triple-slash references and `@jsxImportSource`, comments and strings too,
 * since over-matching only refuses a check. A client writes `text`, so every step is linear in it.
 */
export const outsideModules = (path: string, text: string): ReadonlyArray<OutsideModule> => {
  // Every index of a needle, found once, so no scan rereads an unterminated comment or string.
  const indexes = new Map<string, ReadonlyArray<number>>();
  const all = (needle: string): ReadonlyArray<number> => {
    const known = indexes.get(needle);
    if (known !== undefined) return known;
    const found: Array<number> = [];
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      found.push(at);
    }
    indexes.set(needle, found);
    return found;
  };
  // How many of the ascending `sorted` are below `value`.
  const rank = (sorted: ReadonlyArray<number>, value: number): number => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((sorted[middle] ?? 0) < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const next = (needle: string, from: number): number => {
    const found = all(needle);
    return found[rank(found, from)] ?? text.length;
  };

  const skipGap = (from: number): number => {
    let i = from;
    while (i < text.length) {
      if (/\s/.test(text.charAt(i))) i += 1;
      else if (text.startsWith("/*", i)) i = next("*/", i + 2) + 2;
      else if (text.startsWith("//", i)) i = next("\n", i + 2);
      else break;
    }
    return i;
  };

  // The text of the string literal that opens at `open`, or undefined when none does.
  const quoted = (open: number): string | undefined => {
    const quote = text.charAt(open);
    if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
    const close = next(quote, open + 1);
    // Only a template literal may span lines.
    if (close === text.length || (quote !== "`" && next("\n", open + 1) < close)) return undefined;
    return close - open - 1 > MAX_SPECIFIER ? TOO_LONG : text.slice(open + 1, close);
  };

  const found: Array<OutsideModule> = [];
  const report = (start: number, specifier: string) => {
    if (specifier !== TOO_LONG && !specifierLeavesRepo(path, specifier)) return;
    const newlines = all("\n");
    const before = rank(newlines, start);
    found.push({
      line: before + 1,
      column: start - (newlines[before - 1] ?? -1),
      specifier,
    });
  };

  for (const match of text.matchAll(IMPORT)) {
    let i = skipGap(match.index + match[0].length);
    if (text.charAt(i) === "(") i = skipGap(i + 1);
    const specifier = quoted(i);
    if (specifier !== undefined) report(i + 1, specifier);
  }
  for (const reference of text.matchAll(REFERENCE)) {
    for (const attribute of reference[0].matchAll(REFERENCE_PATH)) {
      const open = reference.index + attribute.index + attribute[0].length;
      const specifier = quoted(open);
      if (specifier !== undefined) report(open + 1, specifier);
    }
  }
  for (const pragma of text.matchAll(JSX_IMPORT_SOURCE)) {
    const start = pragma.index + pragma[0].length;
    PRAGMA_END.lastIndex = start;
    const stop = PRAGMA_END.exec(text)?.index ?? text.length;
    if (stop > start) {
      report(start, stop - start > MAX_SPECIFIER ? TOO_LONG : text.slice(start, stop));
    }
  }
  return found.toSorted((a, b) => a.line - b.line || a.column - b.column);
};
