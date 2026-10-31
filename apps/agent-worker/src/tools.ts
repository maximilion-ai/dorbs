import type { Workspace } from "@cloudflare/computer";
import type { ToolKind } from "@dorbs/protocol/acp";
import {
  CheckId,
  type CheckResponse,
  type Diagnostic,
  type Rejected,
  type SetupFailed,
  type TestResponse,
} from "@dorbs/protocol/checker";
import { CommitSha, RelativePath, type RepoId } from "@dorbs/protocol/typecheck";
import { Type, validateToolArguments, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { Plugin } from "@opencode/plugin";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";

import { gh } from "./gh.ts";
import { git, isGitPath } from "./git.ts";
import type { GitHub } from "./GitHub.ts";
import type { Change, Clone, TestSelection } from "./Checker.ts";

export const WORKSPACE_ROOT = "/workspace";

/** What a tool reaches through the connection that runs it. */
export type ToolHost = {
  readonly workspace: Workspace;
  /** The repos clone_repo may clone: their urls by id. */
  readonly repos: () => Promise<ReadonlyMap<RepoId, string>>;
  /** The repo the workspace was cloned from, once clone_repo has run. */
  readonly clone: () => Clone | undefined;
  readonly saveClone: (clone: Clone) => void;
  /** Runs the repo's static checks, or only the named ones, on the commit with the change laid over it. */
  readonly check: (
    clone: Clone,
    change: Change,
    only: ReadonlyArray<CheckId> | undefined,
  ) => Promise<CheckResponse>;
  /** Runs the repo's test command on the selected tests, on the commit with the change laid over it. */
  readonly test: (clone: Clone, change: Change, selection: TestSelection) => Promise<TestResponse>;
  readonly github: () => Promise<GitHub["Service"]>;
};

/** A write's before and after, sent as the tool result's `details` and shown to the client as a diff. */
export const FileChange = Schema.Struct({
  path: RelativePath,
  oldText: Schema.optionalKey(Schema.String),
  newText: Schema.String,
});
export type FileChange = typeof FileChange.Type;

/** A call's arguments as tool events carry them, before any schema narrows them. */
type Args = Readonly<Record<string, unknown>>;

const arg = (args: Args, key: string): string | undefined =>
  typeof args[key] === "string" ? args[key] : undefined;

const strings = (args: Args, key: string): ReadonlyArray<string> => {
  const value = args[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
};

type Row<P extends TSchema> = {
  readonly name: string;
  readonly kind: ToolKind;
  /** T3's label for a call. For execute tools, T3 shows a backticked command as the shell line. */
  readonly title: (args: Args) => string;
  readonly description: string;
  readonly parameters: P;
  /** Whether Pi may run an eviction-interrupted call again. */
  readonly replay: "safe" | "unsafe";
  readonly run: (args: Static<P>, host: ToolHost) => Promise<ToolExecutionResult>;
};

type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0];
type OpenCodeTool = Parameters<ToolEditor["add"]>[0];

/** Arguments as a model sends them: a JSON object. */
export const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

/** Takes a call's `details`, such as a write's FileChange, which OpenCode's tool events do not carry. */
export type KeepDetails = (toolCallId: string, details: unknown) => void;

const row = <P extends TSchema>(tool: Row<P>) => ({
  name: tool.name,
  kind: tool.kind,
  title: tool.title,
  register: (host: ToolHost): ToolRegistration<P> => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay: tool.replay,
    outputLimits: OUTPUT_LIMITS,
    execute: (args) => tool.run(args, host),
  }),
  // A direct tool, not one of OpenCode's Code Mode tools, with the arguments Pi would pass after its validation.
  openCode: (host: ToolHost, keep: KeepDetails): OpenCodeTool => ({
    name: tool.name,
    description: tool.description,
    // A TypeBox schema is JSON Schema, with TypeBox's symbol keys besides.
    input: Object.fromEntries(Object.entries(tool.parameters)),
    options: { codemode: false },
    execute: async (input, context) => {
      if (!isJsonObject(input)) throw new Error(`${tool.name} takes an object of arguments.`);
      const args: Static<P> = validateToolArguments(tool, {
        type: "toolCall",
        id: context.id,
        name: tool.name,
        arguments: input,
      });
      const result = await tool.run(args, host);
      if (result.details !== undefined) keep(context.id, result.details);
      return {
        content: (result.output ?? [])
          .map((item) => (item.type === "text" ? item.text : ""))
          .join(""),
      };
    },
  }),
});

const decodePath = Schema.decodeUnknownSync(RelativePath);
const decodeCommit = Schema.decodeUnknownSync(CommitSha);
const decodeCheckId = Schema.decodeUnknownSync(CheckId);

// Models often write ./src/a.ts, and . for the workspace root.
const absolute = (path: string): string =>
  `${WORKSPACE_ROOT}/${decodePath(path.replace(/^(\.\/)+/u, ""))}`;

const directory = (path: string | undefined): string =>
  path === undefined || path === "." || path === "./" ? WORKSPACE_ROOT : absolute(path);

const relative = (path: string): string => path.slice(WORKSPACE_ROOT.length + 1);

/**
 * What Pi keeps of one tool result for the model and the transcript. Results stay within it, so their own note on
 * what they cut, which says how to read the rest, is not cut in turn.
 */
export const OUTPUT_LIMITS = { maxBytes: 64 * 1024, maxLines: 2000 };
const BUDGET = OUTPUT_LIMITS.maxBytes - 512;
const encoder = new TextEncoder();

/** How many of `lines`, from the first, fit in one result with a note after them. */
const fitting = (lines: ReadonlyArray<string>): number => {
  let bytes = 0;
  let count = 0;
  for (const line of lines) {
    bytes += encoder.encode(line).length + 1;
    if (bytes > BUDGET || count === OUTPUT_LIMITS.maxLines - 1) break;
    count += 1;
  }
  return count;
};

/** As much of a line too long for one result as fits. */
const head = (line: string): string =>
  line.slice(0, encoder.encodeInto(line, new Uint8Array(BUDGET)).read);

const output = (value: string): ToolExecutionResult => ({
  output: [{ type: "text", text: value }],
});

/** `value` as a tool result, cut to fit with a note that ends in `hint`, how to see the rest. */
const text = (value: string, hint = "Narrow the request to see the rest."): ToolExecutionResult => {
  const lines = value.split("\n");
  const count = fitting(lines);
  if (count === lines.length) return output(value);
  const shown = count === 0 ? head(lines[0] ?? "") : lines.slice(0, count).join("\n");
  return output(`${shown}\n[Cut to its first ${count} of ${lines.length} lines. ${hint}]`);
};

/** Lines `offset` on of a file, at most `limit` of them and as many as fit, with a note on where the rest starts. */
const readLines = (content: string, offset: number, limit: number | undefined): string => {
  const lines = content.split("\n");
  // A final newline ends the last line rather than starting another.
  if (content.endsWith("\n")) lines.pop();
  const from = offset - 1;
  if (from >= lines.length)
    return `The file has ${lines.length} lines; offset ${offset} is past its end.`;
  const wanted = lines.slice(from, limit === undefined ? undefined : from + limit);
  const count = fitting(wanted);
  if (count === 0) {
    const line = wanted[0] ?? "";
    const shown = head(line);
    return `${shown}\n[Line ${offset} is ${line.length} characters long; showing its first ${shown.length}. Search it with grep.]`;
  }
  const end = from + count;
  if (end === lines.length)
    return lines.slice(from).join("\n") + (content.endsWith("\n") ? "\n" : "");
  return `${lines.slice(from, end).join("\n")}\n[Showing lines ${offset}-${end} of ${lines.length}. Call read_file with offset ${end + 1} to read on.]`;
};

// Minified code puts a whole file on one line.
const GREP_LINE = 500;

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

// Computer 0.8.0 types `fs.exists`, but its filesystem has no such method at runtime.
const readIfPresent = (workspace: Workspace, path: string): Promise<string | undefined> =>
  workspace.fs.readFile(path, "utf8").catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });

/**
 * Where a model write to `path` lands. The git directory is refused in any case, since its config steers where
 * pushes send credentials, and so is any path through a symbolic link, which could lead there.
 */
const writable = async (workspace: Workspace, path: string): Promise<string> => {
  const target = absolute(path);
  const names = relative(target).split("/");
  if (isGitPath(relative(target))) {
    throw new Error(
      `${path} is in the repo's git directory, which only the agent writes. Change files with git commands instead.`,
    );
  }
  for (let end = 1; end <= names.length; end += 1) {
    // Computer 0.8.0's runtime filesystem has lstat but not the lstatOrNull it types.
    const stat = await workspace.fs
      .lstat(`${WORKSPACE_ROOT}/${names.slice(0, end).join("/")}`)
      .catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
    if (stat === undefined) break;
    if (stat.isSymbolicLink) {
      throw new Error(
        `${path} goes through a symbolic link. Write to the file it points to instead.`,
      );
    }
  }
  return target;
};

const write = async (
  host: ToolHost,
  path: string,
  newText: string,
): Promise<ToolExecutionResult> => {
  const target = await writable(host.workspace, path);
  const oldText = await readIfPresent(host.workspace, target);
  await host.workspace.fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  await host.workspace.fs.writeFile(target, newText);
  const change: FileChange = {
    path: decodePath(relative(target)),
    ...(oldText === undefined ? {} : { oldText }),
    newText,
  };
  return { ...text(`${oldText === undefined ? "Created" : "Updated"} ${path}`), details: change };
};

// The clone keeps its git directory in the workspace; no tool lists or searches it.
const NOT_GIT = { exclude: [".git"] };

/** The workspace's files that differ from `commit`, new ones included, and those deleted since. */
const changesSince = async (workspace: Workspace, commit: CommitSha): Promise<Change> => {
  const entries = await workspace.git.diffSummary({ dir: WORKSPACE_ROOT, ref: commit });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.status !== "D")
      .map(async (entry) => ({
        path: decodePath(entry.path),
        content: await workspace.fs.readFile(absolute(entry.path), "utf8"),
      })),
  );
  const deleted = entries.filter((entry) => entry.status === "D").map((e) => decodePath(e.path));
  return { files, deleted };
};

const rejectionText = ({ reason }: Rejected, clone: Clone): string =>
  Match.valueTags(reason, {
    UnknownRepo: () => `Not checked: the checker does not have ${clone.repo} registered.`,
    UnknownCommit: () =>
      `Not checked: the checker cannot fetch commit ${clone.commit} of ${clone.repo}.`,
    NoRecipe: ({ reason: why }) =>
      `Not checked: the checker does not know how to check this repo. ${why}`,
    UnknownChecks: ({ ids, known }) =>
      `Not checked: this repo has no check ${ids.join(", ")}. Its checks: ${known.join(", ")}.`,
    NoTestCommand: ({ reason: why }) => `Not run: ${why}`,
    UnsafePath: ({ paths }) =>
      `Not checked: ${paths.join(", ")} go through a symbolic link or replace a directory in the repo.`,
  });

const setupText = (failed: SetupFailed): string =>
  `Not checked: setting up the repo's environment failed at its ${failed.step} step. ` +
  `The next call tries again in a few minutes. Its output ends:\n${failed.output}`;

const SEVERITIES = ["error", "error", "warning", "info", "hint"];

const formatDiagnostic = (d: Diagnostic): string =>
  `${d.path}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITIES[d.severity]}${d.code === undefined ? "" : ` ${d.code}`} ${d.message} (${d.source})`;

/** One line per check, then its diagnostics, and for a failure without any, what the tool printed. */
const checkText = (response: CheckResponse, clone: Clone): string => {
  if (response._tag === "Rejected") return rejectionText(response, clone);
  if (response._tag === "SetupFailed") return setupText(response);
  if (response.checks.length === 0) return "This repo has no checks the checker runs.";
  return response.checks
    .flatMap((run) => {
      const status =
        run.status === "failed"
          ? `failed (exit ${run.exitCode})`
          : run.status === "timed_out"
            ? "timed out"
            : run.status;
      const lines = [
        `${run.id} ${status}: ${run.command}`,
        ...run.diagnostics.map(formatDiagnostic),
      ];
      if (run.status !== "passed" && run.diagnostics.length === 0) lines.push(...run.output);
      if (run.truncated)
        lines.push(`[${run.id}'s output was cut, so some diagnostics may be missing.]`);
      return lines;
    })
    .join("\n");
};

const testText = (response: TestResponse, clone: Clone): string => {
  if (response._tag === "Rejected") return rejectionText(response, clone);
  if (response._tag === "SetupFailed") return setupText(response);
  const status =
    response.status === "failed"
      ? `failed (exit ${response.exitCode})`
      : response.status === "timed_out"
        ? "timed out"
        : response.status;
  const counts =
    response.passed === undefined
      ? "the runner printed no summary."
      : `${response.passed} passed, ${response.failed ?? 0} failed, ${response.skipped ?? 0} skipped.`;
  const head = `Tests ${status}: ${counts}\n$ ${response.command}`;
  return response.status === "passed" ? head : `${head}\n${response.output}`;
};

const urlOf = async (host: ToolHost, clone: Clone): Promise<string | undefined> =>
  (await host.repos()).get(clone.repo);

const Args = (program: string, example: string) =>
  Type.Object({
    args: Type.String({ description: `Everything after ${program}, such as ${example}` }),
  });

const Path = Type.String({ description: "Path relative to the workspace root, such as src/a.ts" });

/** Every tool the agent offers the model. Shell joins as a row here. */
const TOOLS = [
  row({
    name: "read_file",
    title: (args) => `read_file ${arg(args, "path")}`,
    kind: "read",
    description:
      "Read a UTF-8 text file from the workspace. Long files come in parts; offset and limit pick lines.",
    parameters: Type.Object({
      path: Path,
      offset: Type.Optional(
        Type.Integer({ minimum: 1, description: "First line to read, from 1" }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Most lines to read" })),
    }),
    replay: "safe",
    run: async ({ path, offset = 1, limit }, { workspace }) =>
      output(readLines(await workspace.fs.readFile(absolute(path), "utf8"), offset, limit)),
  }),
  row({
    name: "write_file",
    title: (args) => `write_file ${arg(args, "path")}`,
    kind: "edit",
    description: "Create or replace a whole file in the workspace.",
    parameters: Type.Object({ path: Path, content: Type.String() }),
    replay: "safe",
    run: ({ path, content }, host) => write(host, path, content),
  }),
  row({
    name: "edit_file",
    title: (args) => `edit_file ${arg(args, "path")}`,
    kind: "edit",
    description: "Replace the one occurrence of oldText with newText in a workspace file.",
    parameters: Type.Object({ path: Path, oldText: Type.String(), newText: Type.String() }),
    // A rerun would not find oldText it already replaced.
    replay: "unsafe",
    run: async ({ path, oldText, newText }, host) => {
      const current = await host.workspace.fs.readFile(
        await writable(host.workspace, path),
        "utf8",
      );
      const at = current.indexOf(oldText);
      if (at === -1 || current.indexOf(oldText, at + 1) !== -1) {
        throw new Error(`oldText must occur exactly once in ${path}`);
      }
      return write(host, path, current.slice(0, at) + newText + current.slice(at + oldText.length));
    },
  }),
  row({
    name: "list_files",
    title: (args) => ["list_files", arg(args, "path")].filter(Boolean).join(" "),
    kind: "search",
    description: "List the files under a workspace directory, or the whole workspace.",
    parameters: Type.Object({ path: Type.Optional(Path) }),
    replay: "safe",
    run: async ({ path }, { workspace }) => {
      const entries = await workspace.fs.find(directory(path), "**/*", NOT_GIT);
      const files = entries.filter((entry) => entry.type === "file").map((e) => relative(e.path));
      return text(
        files.length === 0 ? "No files." : files.join("\n"),
        "List a subdirectory to see the rest.",
      );
    },
  }),
  row({
    name: "grep",
    title: (args) => ["grep", arg(args, "pattern"), arg(args, "path")].filter(Boolean).join(" "),
    kind: "search",
    description: "Search workspace files for a regular expression.",
    parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Path) }),
    replay: "safe",
    run: async ({ pattern, path }, { workspace }) => {
      const matches = await workspace.fs.grep(pattern, directory(path), {
        regex: true,
        limit: 200,
        ...NOT_GIT,
      });
      return text(
        matches.length === 0
          ? "No matches."
          : matches
              .map((m) => {
                const line = m.text.length > GREP_LINE ? `${m.text.slice(0, GREP_LINE)}…` : m.text;
                return `${relative(m.path)}:${m.line}: ${line}`;
              })
              .join("\n"),
        "Narrow the pattern or the path.",
      );
    },
  }),
  row({
    name: "clone_repo",
    title: (args) => `\`git clone ${arg(args, "repo")}\``,
    kind: "execute",
    description:
      "Clone a registered repo into the workspace root. Type checks run against the cloned commit.",
    parameters: Type.Object({ repo: Type.String({ description: "Repo id, such as owner/name" }) }),
    replay: "safe",
    run: async ({ repo }, host) => {
      const repos = await host.repos();
      const [id, url] = [...repos].find(([registered]) => registered === repo) ?? [];
      if (id === undefined || url === undefined) {
        throw new Error(
          `${repo} is not a registered repo. Registered: ${[...repos.keys()].join(", ")}`,
        );
      }
      const cloned = host.clone();
      if (cloned !== undefined) {
        if (cloned.repo !== id) throw new Error(`The workspace already holds ${cloned.repo}.`);
        return text(`${id} is already cloned at ${cloned.commit} into the workspace root.`);
      }
      const headers = await (await host.github()).headers(url);
      await host.workspace.git.clone({
        url,
        dir: WORKSPACE_ROOT,
        depth: 1,
        ...(headers === undefined ? {} : { headers: { ...headers } }),
      });
      const commit = decodeCommit(
        await host.workspace.git.revParse({ dir: WORKSPACE_ROOT, ref: "HEAD" }),
      );
      const branch = await host.workspace.git.currentBranch({ dir: WORKSPACE_ROOT });
      if (branch === undefined) throw new Error(`${id} cloned without a branch checked out.`);
      host.saveClone({ repo: id, commit, branch });
      return text(
        `Cloned ${id} at ${commit} into the workspace root. Paths are relative to the repo root.`,
      );
    },
  }),
  row({
    name: "check",
    title: (args) => `\`${["check", ...strings(args, "only")].join(" ")}\``,
    kind: "execute",
    description:
      "Run the repo's static checks, such as its typecheck and lint scripts, on the cloned repo with your " +
      "changes, in a warm environment with the repo's dependencies installed. only names checks to run.",
    parameters: Type.Object({
      only: Type.Optional(
        Type.Array(Type.String(), {
          description: "Check ids to run, such as typecheck; all when absent",
        }),
      ),
    }),
    // A rerun checks the same workspace again; the checker restores its environment after each run.
    replay: "safe",
    run: async ({ only }, host) => {
      const clone = host.clone();
      if (clone === undefined) {
        return text("No repo is cloned, so there is nothing to check. Call clone_repo first.");
      }
      const ids = only?.map((id) => decodeCheckId(id));
      return text(
        checkText(
          await host.check(clone, await changesSince(host.workspace, clone.commit), ids),
          clone,
        ),
        "Fix these first, or check with only to see one check at a time.",
      );
    },
  }),
  row({
    name: "test",
    title: (args) => {
      const filter = arg(args, "filter");
      return `\`${["test", ...strings(args, "files"), ...(filter === undefined ? [] : ["-t", filter])].join(" ")}\``;
    },
    kind: "execute",
    description:
      "Run the repo's own test runner, such as vitest, node --test, pytest, cargo test or go test, on the " +
      "cloned repo with your changes. Name the test files (pytest also takes test ids) or a test name filter.",
    parameters: Type.Object({
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: "Test files relative to the repo root, such as src/a.test.ts",
        }),
      ),
      filter: Type.Optional(Type.String({ description: "Run only the tests whose name matches" })),
    }),
    // Tests run in the checker's environment, which it restores afterwards; nothing outside it changes.
    replay: "safe",
    run: async ({ files, filter }, host) => {
      const clone = host.clone();
      if (clone === undefined) {
        return text("No repo is cloned, so there are no tests to run. Call clone_repo first.");
      }
      const selection = {
        ...(files === undefined ? {} : { files }),
        ...(filter === undefined ? {} : { filter }),
      };
      // The checker keeps the end of a long run's output, where the failures and the summary are.
      return text(
        testText(
          await host.test(clone, await changesSince(host.workspace, clone.commit), selection),
          clone,
        ),
        "Run fewer tests to see the rest.",
      );
    },
  }),
  row({
    name: "git",
    title: (args) => `\`git ${arg(args, "args")}\``,
    kind: "execute",
    description:
      "Run git in the cloned repo, one command per call, without shell operators. " +
      "Commit on a new branch under dorbs/, such as dorbs/add-x, and push it to origin; " +
      "pushes to other branches are refused. " +
      "fetch, pull, clone, remote and config are not available.",
    parameters: Args("git", 'status, commit -m "Add x" or push -u origin my-branch'),
    replay: "unsafe",
    run: async ({ args }, host) => {
      const clone = host.clone();
      if (clone === undefined) {
        return text("No repo is cloned, so there is no git repository. Call clone_repo first.");
      }
      const [url, { headers }] = await Promise.all([urlOf(host, clone), host.github()]);
      return text(
        await git(args, {
          workspace: host.workspace,
          dir: WORKSPACE_ROOT,
          clone,
          // Read again, not the clone above: pushes in one round run at once.
          created: (branch) => {
            const current = host.clone();
            if (current !== undefined) {
              host.saveClone({ ...current, created: [...(current.created ?? []), branch] });
            }
          },
          url,
          headers,
        }),
        "Narrow the command, such as git log -n 20 or git diff -- <path>.",
      );
    },
  }),
  row({
    name: "gh",
    title: (args) => `\`gh ${arg(args, "args")}\``,
    kind: "execute",
    description:
      "Run the GitHub CLI on the cloned GitHub repo, one command per call. Supported: pr create, " +
      "pr view, pr list, pr comment, issue view and repo view. Push your branch before gh pr create.",
    parameters: Args("gh", 'pr create --title "Add x" --body "Adds x."'),
    replay: "unsafe",
    run: async ({ args }, host) => {
      const clone = host.clone();
      const [url, { api }] = await Promise.all([
        clone === undefined ? undefined : urlOf(host, clone),
        host.github(),
      ]);
      const currentBranch = () => host.workspace.git.currentBranch({ dir: WORKSPACE_ROOT });
      return text(
        await gh(args, { clone, url, api, currentBranch }),
        "Narrow the command, such as gh pr list --state open.",
      );
    },
  }),
];

/** How the client shows a call of tool `name`: its title and ACP kind. */
export const toolPresentation = (
  name: string,
  args: Args,
): { readonly title: string; readonly kind: ToolKind } => {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  return tool === undefined
    ? { title: name, kind: "other" }
    : { title: tool.title(args), kind: tool.kind };
};

export const registerTools = (host: ToolHost): ToolRegistration[] =>
  TOOLS.map((tool) => tool.register(host));

export const openCodeTools = (host: ToolHost, keep: KeepDetails): OpenCodeTool[] =>
  TOOLS.map((tool) => tool.openCode(host, keep));
