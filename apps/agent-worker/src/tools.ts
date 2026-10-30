import type { Workspace } from "@cloudflare/computer";
import type { ToolKind } from "@dorbs/protocol/acp";
import {
  CommitSha,
  RelativePath,
  type ActionResult,
  type Diagnostic,
  type Rejected,
  type RepoId,
} from "@dorbs/protocol/typecheck";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";

import { gh } from "./gh.ts";
import { git, isGitPath } from "./git.ts";
import type { GitHub } from "./GitHub.ts";
import type { Change, Clone } from "./Typecheck.ts";

export const WORKSPACE_ROOT = "/workspace";

/** What a tool reaches through the connection that runs it. */
export type ToolHost = {
  readonly workspace: Workspace;
  /** The repos clone_repo may clone: their urls by id. */
  readonly repos: () => Promise<ReadonlyMap<RepoId, string>>;
  /** The repo the workspace was cloned from, once clone_repo has run. */
  readonly clone: () => Clone | undefined;
  readonly saveClone: (clone: Clone) => void;
  readonly typecheck: (clone: Clone, change: Change) => Promise<ActionResult | Rejected>;
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

const row = <P extends TSchema>(tool: Row<P>) => ({
  name: tool.name,
  kind: tool.kind,
  title: tool.title,
  register: (host: ToolHost): ToolRegistration<P> => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay: tool.replay,
    execute: (args) => tool.run(args, host),
  }),
});

const decodePath = Schema.decodeUnknownSync(RelativePath);
const decodeCommit = Schema.decodeUnknownSync(CommitSha);

// Models often write ./src/a.ts, and . for the workspace root.
const absolute = (path: string): string =>
  `${WORKSPACE_ROOT}/${decodePath(path.replace(/^(\.\/)+/u, ""))}`;

const directory = (path: string | undefined): string =>
  path === undefined || path === "." || path === "./" ? WORKSPACE_ROOT : absolute(path);

const relative = (path: string): string => path.slice(WORKSPACE_ROOT.length + 1);

const text = (value: string): ToolExecutionResult => ({ output: [{ type: "text", text: value }] });

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
    UnknownToolchain: () =>
      "Not checked: the typecheck service does not run this agent's toolchain.",
    UnknownRepo: () => `Not checked: the typecheck service does not have ${clone.repo} registered.`,
    UnknownCommit: () =>
      `Not checked: the typecheck service cannot fetch commit ${clone.commit} of ${clone.repo}.`,
    ProtectedPaths: ({ paths }) =>
      `Not checked: ${paths.join(", ")} changed. The check takes dependencies and config ` +
      `from commit ${clone.commit}, so dependency and config changes must be pushed first. ` +
      "Undo these changes to check the rest.",
  });

const formatDiagnostic = (d: Diagnostic): string =>
  `${d.path}:${d.line}:${d.column} ${d.severity} ${d.code} ${d.message} (${d.tool})`;

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
    description: "Read a UTF-8 text file from the workspace.",
    parameters: Type.Object({ path: Path }),
    replay: "safe",
    run: async ({ path }, { workspace }) =>
      text(await workspace.fs.readFile(absolute(path), "utf8")),
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
      return text(files.length === 0 ? "No files." : files.join("\n"));
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
          : matches.map((m) => `${relative(m.path)}:${m.line}: ${m.text}`).join("\n"),
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
    name: "typecheck",
    title: () => "`typecheck`",
    kind: "execute",
    description: "Type-check and lint the cloned repo with your changes, using tsrs and oxlint.",
    parameters: Type.Object({}),
    replay: "safe",
    run: async (_args, host) => {
      const clone = host.clone();
      if (clone === undefined) {
        return text("No repo is cloned, so there is nothing to check. Call clone_repo first.");
      }
      const result = await host.typecheck(clone, await changesSince(host.workspace, clone.commit));
      if (result._tag === "Rejected") return text(rejectionText(result, clone));
      return text(
        result.diagnostics.length === 0
          ? "No diagnostics."
          : result.diagnostics.map(formatDiagnostic).join("\n"),
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
          saveClone: host.saveClone,
          url,
          headers,
        }),
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
      return text(await gh(args, { clone, url, api, currentBranch }));
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
