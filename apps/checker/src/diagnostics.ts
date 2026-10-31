import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import type { Diagnostic, Severity } from "@dorbs/protocol/checker";
import { RelativePath } from "@dorbs/protocol/typecheck";

import type { DiagnosticFormat } from "./Recipe.ts";

export type ParseContext = {
  /** The repo root as the tool sees it, such as /env/repo. */
  readonly root: string;
  /** The directory the tool ran in, relative to the repo root. */
  readonly cwd: string;
  /** The source of a diagnostic no known tool claims, such as go-build: the check's id. */
  readonly source: string;
  /** Workspace package directories by package name, for turbo's and nx's `name:task:` prefixes. */
  readonly packages: ReadonlyMap<string, string>;
};

export type Parsed = {
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  /** Lines no parser understood, trimmed, blank ones and repeats dropped. */
  readonly output: ReadonlyArray<string>;
};

const isRelativePath = Schema.is(RelativePath);

/** `path`, as the tool printed it from `cwd`, relative to the repo root; undefined outside the repo. */
const repoPath = (context: ParseContext, cwd: string, path: string): RelativePath | undefined => {
  const absolute = NodePath.posix.isAbsolute(path)
    ? NodePath.posix.normalize(path)
    : NodePath.posix.join(context.root, cwd, path);
  if (!absolute.startsWith(`${context.root}/`)) return undefined;
  const relative = absolute.slice(context.root.length + 1);
  return isRelativePath(relative) ? relative : undefined;
};

const SEVERITIES: Readonly<Record<string, Severity>> = {
  error: 1,
  fatal: 1,
  warning: 2,
  warn: 2,
  information: 3,
  info: 3,
  note: 3,
  notice: 3,
  message: 3,
  hint: 4,
};
const severityOf = (word: string): Severity => SEVERITIES[word.toLowerCase()] ?? 1;

/** A one-based line and column from a tool, as LSP's zero-based position. */
const position = (line: number, column: number) => ({
  line: Math.max(0, line - 1),
  character: Math.max(0, column - 1),
});

type Located = {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endLine?: number | undefined;
  readonly endColumn?: number | undefined;
  readonly severity: Severity;
  readonly code?: string | undefined;
  readonly source: string;
  readonly message: string;
};

const diagnostic = (
  context: ParseContext,
  cwd: string,
  located: Located,
): Diagnostic | undefined => {
  const path = repoPath(context, cwd, located.path);
  if (path === undefined) return undefined;
  const start = position(located.line, located.column);
  const end =
    located.endLine === undefined
      ? start
      : position(located.endLine, located.endColumn ?? located.column);
  return {
    path,
    range: { start, end },
    severity: located.severity,
    ...(located.code === undefined || located.code === "" ? {} : { code: located.code }),
    source: located.source,
    message: located.message,
  };
};

/** Collects diagnostics and leftover lines, each once. */
const collector = () => {
  const diagnostics: Array<Diagnostic> = [];
  const output = new Set<string>();
  const raw = (text: string) => {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed !== "") output.add(trimmed);
    }
  };
  return {
    add: (found: Diagnostic | undefined, line: string) => {
      if (found === undefined) raw(line);
      else diagnostics.push(found);
    },
    /** Appends a continuation line to the last diagnostic's message. */
    extend: (line: string) => {
      const last = diagnostics.pop();
      if (last !== undefined) diagnostics.push({ ...last, message: `${last.message}\n${line}` });
    },
    raw,
    result: (): Parsed => ({
      diagnostics: [...new Map(diagnostics.map((d) => [JSON.stringify(d), d])).values()],
      output: [...output],
    }),
  };
};
type Collector = ReturnType<typeof collector>;

const TSC = /^((?:(?!: ).)+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;
const GITHUB = /^::(error|warning|notice) ([^:]*)::(.*)$/;
const PRETTIER = /^\[warn\] (\S+)$/;
const PYRIGHT = /^\s*(\S.*?):(\d+):(\d+) - (error|warning|information): (.*?)(?: \((\w+)\))?$/;
const SVELTE_MACHINE =
  /^\d+ (ERROR|WARNING|HINT) ("(?:[^"\\]|\\.)*") (\d+):(\d+) ("(?:[^"\\]|\\.)*")$/;
const SVELTE_LOCATION = /^(\S.*):(\d+):(\d+)$/;
const SVELTE_MESSAGE = /^(Error|Warn|Hint): (.*?)(?: \((?:ts|js|svelte|css)\))?\s*$/;
const STYLISH_FILE = /^(\/\S.*|\S+\.\w+)$/;
const STYLISH_ENTRY = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/;
// file:line:col: message, and mypy's file:line: severity: message [code].
const GNU =
  /^(?:vet: )?([^\s:()][^:()]*?):(\d+)(?::(\d+))?: (?:(error|warning|note): )?(.*?)(?:\s+\[([\w-]+)\])?$/;
const PNPM_PREFIX = /^([\w@.+-]+(?:\/[\w@.+-]+)*) [\w:.-]+: (.*)$/;
const TURBO_PREFIX = /^([@\w./-]+):[\w:.-]+: (.*)$/;

const BIOME_CATEGORY = /^(?:lint|assist|format|organizeImports|syntax|parse)\b/;

const githubParams = (text: string): Record<string, string> =>
  Object.fromEntries(
    text.split(",").flatMap((pair) => {
      const at = pair.indexOf("=");
      return at === -1 ? [] : [[pair.slice(0, at), pair.slice(at + 1)]];
    }),
  );

const parseJsonString = (quoted: string): string => {
  const value: unknown = JSON.parse(quoted);
  return typeof value === "string" ? value : quoted;
};

/** One line in one of the formats `text` reads, or undefined. */
const lineDiagnostic = (
  context: ParseContext,
  cwd: string,
  line: string,
): Diagnostic | undefined => {
  const tsc = TSC.exec(line);
  if (tsc !== null) {
    const [, path = "", row, column, severity = "", code, message = ""] = tsc;
    return diagnostic(context, cwd, {
      path,
      line: Number(row),
      column: Number(column),
      severity: severityOf(severity),
      code,
      source: "tsc",
      message,
    });
  }
  const github = GITHUB.exec(line);
  if (github !== null) {
    const [, severity = "", params = "", message = ""] = github;
    const { title, file, line: row, col, endLine, endColumn } = githubParams(params);
    if (file === undefined) return undefined;
    return diagnostic(context, cwd, {
      path: file,
      line: Number(row ?? 1),
      column: Number(col ?? 1),
      endLine: endLine === undefined ? undefined : Number(endLine),
      endColumn: endColumn === undefined ? undefined : Number(endColumn),
      severity: severityOf(severity),
      code: title,
      source: title !== undefined && BIOME_CATEGORY.test(title) ? "biome" : context.source,
      message,
    });
  }
  const pyright = PYRIGHT.exec(line);
  if (pyright !== null) {
    const [, path = "", row, column, severity = "", message = "", rule] = pyright;
    return diagnostic(context, cwd, {
      path,
      line: Number(row),
      column: Number(column),
      severity: severityOf(severity),
      code: rule,
      source: "pyright",
      message,
    });
  }
  const prettier = PRETTIER.exec(line);
  if (prettier !== null) {
    return diagnostic(context, cwd, {
      path: prettier[1] ?? "",
      line: 1,
      column: 1,
      severity: 2,
      source: "prettier",
      message: "The file is not formatted as Prettier would format it.",
    });
  }
  const svelte = SVELTE_MACHINE.exec(line);
  if (svelte !== null) {
    const [, severity = "", path = "", row, column, message = ""] = svelte;
    return diagnostic(context, cwd, {
      path: parseJsonString(path),
      line: Number(row),
      column: Number(column),
      severity: severityOf(severity),
      source: "svelte-check",
      message: parseJsonString(message),
    });
  }
  const gnu = GNU.exec(line);
  if (gnu !== null) {
    const [, path = "", row, column, severity, message = "", code] = gnu;
    return diagnostic(context, cwd, {
      path,
      line: Number(row),
      column: Number(column ?? 1),
      severity: severity === undefined ? 1 : severityOf(severity),
      code,
      source: context.source,
      message,
    });
  }
  return undefined;
};

type Line = {
  /** The line without the package prefix. */
  readonly body: string;
  /** The line as printed, which output keeps. */
  readonly raw: string;
};

/**
 * Output split into one stream per package, by the prefix pnpm -r and --parallel or turbo puts before
 * each line, so a two-line message stays whole when packages' lines interleave.
 */
const streams = (context: ParseContext, text: string): ReadonlyMap<string, ReadonlyArray<Line>> => {
  const dirs = new Set(context.packages.values());
  const byDir = new Map<string, Array<Line>>();
  for (const printed of text.split("\n")) {
    const raw = printed.replace(/\s+$/, "");
    let cwd = context.cwd;
    let body = raw;
    const turbo = TURBO_PREFIX.exec(raw);
    const turboDir = turbo === null ? undefined : context.packages.get(turbo[1] ?? "");
    const pnpm = PNPM_PREFIX.exec(raw);
    const pnpmDir = pnpm?.[1] ?? "";
    if (turbo !== null && turboDir !== undefined) {
      cwd = turboDir;
      body = turbo[2] ?? "";
    } else if (
      pnpm !== null &&
      isRelativePath(pnpmDir) &&
      (dirs.has(pnpmDir) || pnpmDir.includes("/"))
    ) {
      cwd = NodePath.posix.join(context.cwd, pnpmDir);
      body = pnpm[2] ?? "";
    }
    const bucket = byDir.get(cwd) ?? [];
    if (bucket.length === 0) byDir.set(cwd, bucket);
    bucket.push({ body, raw });
  }
  return byDir;
};

const parseStream = (
  context: ParseContext,
  cwd: string,
  lines: ReadonlyArray<Line>,
  into: Collector,
) => {
  let stylishFile: string | undefined;
  // tsc and svelte-check indent the rest of a message under its first line.
  let continuing = false;
  for (let index = 0; index < lines.length; index += 1) {
    const { body: line, raw } = lines[index] ?? { body: "", raw: "" };
    if (continuing && /^\s+\S/.test(line)) {
      into.extend(line);
      continue;
    }
    continuing = false;
    const entry = stylishFile === undefined ? null : STYLISH_ENTRY.exec(line);
    if (entry !== null && stylishFile !== undefined) {
      const [, row, column, severity = "", message = "", rule] = entry;
      into.add(
        diagnostic(context, cwd, {
          path: stylishFile,
          line: Number(row),
          column: Number(column),
          severity: severityOf(severity),
          code: rule,
          source: "eslint",
          message,
        }),
        raw,
      );
      continue;
    }
    stylishFile = undefined;
    const location = SVELTE_LOCATION.exec(line);
    const next = SVELTE_MESSAGE.exec(lines[index + 1]?.body ?? "");
    if (location !== null && next !== null) {
      const [, path = "", row, column] = location;
      const found = diagnostic(context, cwd, {
        path,
        line: Number(row),
        column: Number(column),
        severity: severityOf(next[1] ?? ""),
        source: "svelte-check",
        message: next[2] ?? "",
      });
      into.add(found, `${raw}\n${lines[index + 1]?.raw ?? ""}`);
      continuing = found !== undefined;
      index += 1;
      continue;
    }
    const found = lineDiagnostic(context, cwd, line);
    if (
      found === undefined &&
      STYLISH_FILE.test(line) &&
      STYLISH_ENTRY.test(lines[index + 1]?.body ?? "")
    ) {
      stylishFile = line;
      continue;
    }
    into.add(found, raw);
    continuing = found?.source === "tsc";
  }
};

/** The line formats repos' own scripts print, including two-line ones: eslint's stylish and svelte-check's. */
const parseText = (context: ParseContext, text: string, into: Collector) => {
  for (const [cwd, lines] of streams(context, text)) parseStream(context, cwd, lines, into);
};

const EslintOutput = Schema.Array(
  Schema.Struct({
    filePath: Schema.String,
    messages: Schema.Array(
      Schema.Struct({
        ruleId: Schema.NullOr(Schema.String),
        severity: Schema.Number,
        message: Schema.String,
        line: Schema.optionalKey(Schema.Number),
        column: Schema.optionalKey(Schema.Number),
        endLine: Schema.optionalKey(Schema.Number),
        endColumn: Schema.optionalKey(Schema.Number),
      }),
    ),
  }),
);
const OxlintOutput = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      message: Schema.String,
      code: Schema.optionalKey(Schema.String),
      severity: Schema.String,
      filename: Schema.String,
      labels: Schema.Array(
        Schema.Struct({ span: Schema.Struct({ line: Schema.Number, column: Schema.Number }) }),
      ),
    }),
  ),
});
const LspRange = Schema.Struct({
  start: Schema.Struct({ line: Schema.Number, character: Schema.Number }),
  end: Schema.Struct({ line: Schema.Number, character: Schema.Number }),
});
const PyrightOutput = Schema.Struct({
  generalDiagnostics: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      severity: Schema.String,
      message: Schema.String,
      range: Schema.optionalKey(LspRange),
      rule: Schema.optionalKey(Schema.String),
    }),
  ),
});
const RuffLocation = Schema.Struct({ row: Schema.Number, column: Schema.Number });
const RuffOutput = Schema.Array(
  Schema.Struct({
    code: Schema.NullOr(Schema.String),
    message: Schema.String,
    filename: Schema.String,
    location: RuffLocation,
    end_location: Schema.optionalKey(RuffLocation),
  }),
);
const CargoMessage = Schema.Struct({
  reason: Schema.String,
  message: Schema.optionalKey(
    Schema.Struct({
      message: Schema.String,
      level: Schema.String,
      code: Schema.NullOr(Schema.Struct({ code: Schema.String })),
      spans: Schema.Array(
        Schema.Struct({
          file_name: Schema.String,
          line_start: Schema.Number,
          column_start: Schema.Number,
          line_end: Schema.Number,
          column_end: Schema.Number,
          is_primary: Schema.Boolean,
          label: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ),
});
const GoVetOutput = Schema.Record(
  Schema.String,
  Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        posn: Schema.String,
        end: Schema.optionalKey(Schema.String),
        message: Schema.String,
      }),
    ),
  ),
);

const decodeEslint = Schema.decodeUnknownOption(Schema.fromJsonString(EslintOutput));
const decodeOxlint = Schema.decodeUnknownOption(Schema.fromJsonString(OxlintOutput));
const decodePyright = Schema.decodeUnknownOption(Schema.fromJsonString(PyrightOutput));
const decodeRuff = Schema.decodeUnknownOption(Schema.fromJsonString(RuffOutput));
const decodeCargo = Schema.decodeUnknownOption(Schema.fromJsonString(CargoMessage));
const decodeGoVet = Schema.decodeUnknownOption(Schema.fromJsonString(GoVetOutput));

/** go vet's file:line:col position, absolute. */
const goPosition = (posn: string) => {
  const match = /^(.*):(\d+):(\d+)$/.exec(posn);
  return match === null
    ? undefined
    : { path: match[1] ?? "", line: Number(match[2]), column: Number(match[3]) };
};

/** Reads a JSON document out of `text`, or keeps the text as output when it is not one. */
const json = <A>(
  text: string,
  decode: (
    text: string,
  ) => { readonly _tag: "Some"; readonly value: A } | { readonly _tag: "None" },
  into: Collector,
  read: (value: A) => void,
) => {
  const start = text.search(/^[[{]/m);
  const decoded = start === -1 ? undefined : decode(text.slice(start));
  if (decoded === undefined || decoded._tag === "None") {
    into.raw(text);
    return;
  }
  into.raw(text.slice(0, start));
  read(decoded.value);
};

const FORMATS: Record<
  Exclude<DiagnosticFormat, "text">,
  (context: ParseContext, stdout: string, stderr: string, into: Collector) => void
> = {
  "eslint-json": (context, stdout, stderr, into) => {
    json(stdout, decodeEslint, into, (files) => {
      for (const file of files) {
        for (const m of file.messages) {
          into.add(
            diagnostic(context, context.cwd, {
              path: file.filePath,
              line: m.line ?? 1,
              column: m.column ?? 1,
              endLine: m.endLine,
              endColumn: m.endColumn,
              severity: m.severity === 2 ? 1 : 2,
              code: m.ruleId ?? undefined,
              source: "eslint",
              message: m.message,
            }),
            `${file.filePath}: ${m.message}`,
          );
        }
      }
    });
    parseText(context, stderr, into);
  },
  "oxlint-json": (context, stdout, stderr, into) => {
    json(stdout, decodeOxlint, into, ({ diagnostics }) => {
      for (const d of diagnostics) {
        const span = d.labels[0]?.span;
        into.add(
          diagnostic(context, context.cwd, {
            path: d.filename,
            line: span?.line ?? 1,
            column: span?.column ?? 1,
            severity: severityOf(d.severity),
            code: d.code,
            source: "oxlint",
            message: d.message,
          }),
          `${d.filename}: ${d.message}`,
        );
      }
    });
    parseText(context, stderr, into);
  },
  "pyright-json": (context, stdout, stderr, into) => {
    json(stdout, decodePyright, into, ({ generalDiagnostics }) => {
      for (const d of generalDiagnostics) {
        const range = d.range ?? {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        };
        into.add(
          diagnostic(context, context.cwd, {
            path: d.file,
            line: range.start.line + 1,
            column: range.start.character + 1,
            endLine: range.end.line + 1,
            endColumn: range.end.character + 1,
            severity: severityOf(d.severity),
            code: d.rule,
            source: "pyright",
            message: d.message,
          }),
          `${d.file}: ${d.message}`,
        );
      }
    });
    parseText(context, stderr, into);
  },
  "ruff-json": (context, stdout, stderr, into) => {
    json(stdout, decodeRuff, into, (entries) => {
      for (const d of entries) {
        into.add(
          diagnostic(context, context.cwd, {
            path: d.filename,
            line: d.location.row,
            column: d.location.column,
            endLine: d.end_location?.row,
            endColumn: d.end_location?.column,
            severity: 1,
            code: d.code ?? undefined,
            source: "ruff",
            message: d.message,
          }),
          `${d.filename}: ${d.message}`,
        );
      }
    });
    parseText(context, stderr, into);
  },
  "cargo-json": (context, stdout, stderr, into) => {
    for (const line of stdout.split("\n")) {
      if (line.trim() === "") continue;
      const decoded = decodeCargo(line);
      if (decoded._tag === "None") {
        into.raw(line);
        continue;
      }
      const message = decoded.value.message;
      // Artifacts, build scripts and build-finished are cargo's own records, not messages.
      if (decoded.value.reason !== "compiler-message" || message === undefined) continue;
      const primary = message.spans.find((span) => span.is_primary);
      if (primary === undefined) {
        into.raw(message.message);
        continue;
      }
      into.add(
        diagnostic(context, context.cwd, {
          path: primary.file_name,
          line: primary.line_start,
          column: primary.column_start,
          endLine: primary.line_end,
          endColumn: primary.column_end,
          severity: severityOf(message.level),
          code: message.code?.code,
          source: "rustc",
          message:
            primary.label === null ? message.message : `${message.message}: ${primary.label}`,
        }),
        `${primary.file_name}: ${message.message}`,
      );
    }
    parseText(context, stderr, into);
  },
  "go-vet-json": (context, stdout, stderr, into) => {
    for (const text of [stdout, stderr]) {
      // One JSON object per package, each after a "# package" line, between build errors as text.
      const documents = text.split(/^(?=\{)/m);
      for (const document of documents) {
        const end = document.lastIndexOf("}");
        const decoded = document.startsWith("{")
          ? decodeGoVet(document.slice(0, end + 1))
          : undefined;
        if (decoded === undefined || decoded._tag === "None") {
          parseText(context, document, into);
          continue;
        }
        for (const analyzers of Object.values(decoded.value)) {
          for (const [analyzer, findings] of Object.entries(analyzers)) {
            for (const finding of findings) {
              const start = goPosition(finding.posn);
              const end = finding.end === undefined ? undefined : goPosition(finding.end);
              into.add(
                start === undefined
                  ? undefined
                  : diagnostic(context, context.cwd, {
                      ...start,
                      endLine: end?.line,
                      endColumn: end?.column,
                      severity: 2,
                      code: analyzer,
                      source: context.source,
                      message: finding.message,
                    }),
                `${finding.posn}: ${finding.message}`,
              );
            }
          }
        }
        parseText(context, document.slice(end + 1), into);
      }
    }
  },
};

/** The diagnostics in a check's output, in the format its recipe names, and every line it could not read. */
export const parseOutput = (
  format: DiagnosticFormat,
  stdout: string,
  stderr: string,
  context: ParseContext,
): Parsed => {
  const into = collector();
  if (format === "text") {
    parseText(context, stdout, into);
    parseText(context, stderr, into);
  } else {
    FORMATS[format](context, stdout, stderr, into);
  }
  return into.result();
};
