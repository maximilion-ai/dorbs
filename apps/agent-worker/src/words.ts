/**
 * The grep index: for each content part, the words of each text file in it, by the file's offset in the part. A
 * pattern's literals must each lie within one word of a file it matches, so only files with a word containing every
 * literal piece need a scan.
 */

const WORD = /[\p{L}\p{N}_$]+/gu;
const NOT_WORD = /[^\p{L}\p{N}_$]+/u;
// Shorter pieces sit in most files, so they narrow little.
const MIN_PIECE = 3;

/** One part's index: a line per word, `word\toffset,offset,...`, the offsets in base 36. */
export const indexPart = (
  files: ReadonlyArray<{ readonly offset: number; readonly text: string }>,
): string => {
  const byWord = new Map<string, number[]>();
  for (const { offset, text } of files) {
    const seen = new Set<string>();
    for (const [word] of text.matchAll(WORD)) {
      if (word.length < MIN_PIECE || seen.has(word)) continue;
      seen.add(word);
      const offsets = byWord.get(word);
      if (offsets === undefined) byWord.set(word, [offset]);
      else offsets.push(offset);
    }
  }
  let out = "";
  for (const [word, offsets] of byWord)
    out += `${word}\t${offsets.map((at) => at.toString(36)).join(",")}\n`;
  return out;
};

/** The offsets of the files in a part's index with a word that contains `piece`. */
export const filesWith = (index: string, piece: string): ReadonlySet<number> => {
  const found = new Set<number>();
  let from = 0;
  for (;;) {
    const at = index.indexOf(piece, from);
    if (at === -1) return found;
    const start = index.lastIndexOf("\n", at) + 1;
    const tab = index.indexOf("\t", start);
    const end = index.indexOf("\n", at);
    const lineEnd = end === -1 ? index.length : end;
    // A hit in the offsets after the tab is not a word.
    if (at + piece.length <= tab)
      for (const offset of index.slice(tab + 1, lineEnd).split(","))
        found.add(Number.parseInt(offset, 36));
    from = lineEnd + 1;
  }
};

/** A pattern's alternatives, each the pieces a match must contain. */
export type Plan = ReadonlyArray<ReadonlyArray<string>>;

const CLASS_ESCAPES = new Set([
  "d",
  "D",
  "w",
  "W",
  "s",
  "S",
  "b",
  "B",
  "p",
  "P",
  "u",
  "x",
  "c",
  "k",
]);
const CONTROL_ESCAPES = new Set(["f", "n", "r", "t", "v", "0"]);
const QUANTIFIER = /^\{(\d+)(,\d*)?\}/u;

/** The index of the character after the group or class that opens at `at`. */
const skipBracket = (pattern: string, at: number): number => {
  let depth = 0;
  let inClass = false;
  for (let i = at; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") {
        inClass = false;
        if (depth === 0) return i + 1;
      }
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return pattern.length;
};

/** The quantifier at `at`: its length and whether it lets the item before it be absent, or undefined if none. */
const quantifierAt = (
  pattern: string,
  at: number,
): { readonly length: number; readonly optional: boolean } | undefined => {
  const char = pattern[at];
  let length: number;
  let optional: boolean;
  if (char === "*" || char === "?") [length, optional] = [1, true];
  else if (char === "+") [length, optional] = [1, false];
  else {
    const braces = QUANTIFIER.exec(pattern.slice(at));
    if (braces === null) return undefined;
    [length, optional] = [braces[0].length, Number(braces[1]) === 0];
  }
  // A lazy or possessive mark after it.
  if (pattern[at + length] === "?") length += 1;
  return { length, optional };
};

/**
 * What every match of a regular expression must contain, as pieces of its literal text, or undefined when some match
 * may lack any piece long enough to narrow a search. Conservative: groups, classes and escapes count as unknown text.
 */
export const plan = (pattern: string, flags: string): Plan | undefined => {
  if (flags.includes("i")) return undefined;
  const branches: string[][] = [];
  let runs: string[] = [];
  let run = "";
  const end = () => {
    if (run !== "") runs.push(run);
    run = "";
  };
  for (let at = 0; at < pattern.length;) {
    const char = pattern[at] ?? "";
    if (char === "|") {
      end();
      branches.push(runs);
      runs = [];
      at += 1;
      continue;
    }
    let literal: string | undefined;
    let next: number;
    if (char === "(" || char === "[") {
      next = skipBracket(pattern, at);
    } else if (char === "\\") {
      const escaped = pattern[at + 1] ?? "";
      next = at + 2;
      if (!CLASS_ESCAPES.has(escaped) && !CONTROL_ESCAPES.has(escaped) && !/\d/u.test(escaped))
        literal = escaped;
    } else {
      next = at + 1;
      if (!".^$".includes(char)) literal = char;
    }
    const quantifier = quantifierAt(pattern, next);
    if (quantifier !== undefined) next += quantifier.length;
    if (literal === undefined) end();
    else if (quantifier === undefined) run += literal;
    else {
      // Repeated or optional: the text before it stays, and a required one starts the next run.
      end();
      if (!quantifier.optional) run = literal;
      end();
    }
    at = next;
  }
  end();
  branches.push(runs);
  const pieces = branches.map((branch) =>
    branch.flatMap((text) => text.split(NOT_WORD).filter((piece) => piece.length >= MIN_PIECE)),
  );
  return pieces.every((branch) => branch.length > 0) ? pieces : undefined;
};
