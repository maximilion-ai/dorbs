import * as Schema from "effect/Schema";

class ShellOperator extends Schema.TaggedError<ShellOperator>()("ShellOperator", {
  operator: Schema.String,
}) {
  override get message(): string {
    return `${this.operator} is a shell operator. Run one command per call, with no shell operators.`;
  }
}

class UnclosedQuote extends Schema.TaggedError<UnclosedQuote>()("UnclosedQuote", {
  quote: Schema.String,
}) {
  override get message(): string {
    return `The command has an unclosed ${this.quote}.`;
  }
}

const OPERATORS = ["&&", "||", "$(", "|", ";", "&", ">", "<", "`"];

// Inside double quotes a backslash escapes only these, as in POSIX sh.
const DOUBLE_QUOTED_ESCAPES = new Set(['"', "\\", "$", "`", "\n"]);

/**
 * Splits one command line into words the way sh does for quotes and backslashes. Nothing expands, so
 * an operator, a backtick or `$(` outside single quotes is refused rather than passed on as text.
 */
export const parseArgv = (line: string): ReadonlyArray<string> => {
  const words: string[] = [];
  let word: string | undefined;
  let i = 0;
  const append = (text: string) => {
    word = (word ?? "") + text;
  };
  while (i < line.length) {
    const char = line.charAt(i);
    if (/\s/u.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
      i += 1;
    } else if (char === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new UnclosedQuote({ quote: "single quote" });
      append(line.slice(i + 1, end));
      i = end + 1;
    } else if (char === '"') {
      append("");
      i += 1;
      for (;;) {
        if (i >= line.length) throw new UnclosedQuote({ quote: "double quote" });
        const inner = line.charAt(i);
        if (inner === '"') break;
        if (inner === "`" || line.startsWith("$(", i)) {
          throw new ShellOperator({ operator: inner === "`" ? "`" : "$(" });
        }
        if (inner === "\\" && DOUBLE_QUOTED_ESCAPES.has(line.charAt(i + 1))) {
          append(line.charAt(i + 1));
          i += 2;
        } else {
          append(inner);
          i += 1;
        }
      }
      i += 1;
    } else if (char === "\\") {
      // A backslash before a newline continues the line.
      if (i + 1 < line.length && line.charAt(i + 1) !== "\n") append(line.charAt(i + 1));
      i += 2;
    } else {
      const operator = OPERATORS.find((candidate) => line.startsWith(candidate, i));
      if (operator !== undefined) throw new ShellOperator({ operator });
      append(char);
      i += 1;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
};
