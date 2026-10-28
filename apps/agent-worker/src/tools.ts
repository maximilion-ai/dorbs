import type { Workspace } from "@cloudflare/computer";
import type { ToolKind } from "@dorbs/protocol/acp";
import { RelativePath, type CheckResult, type Diagnostic } from "@dorbs/protocol/typecheck";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";

import type { WorkspaceFile } from "./Typecheck.ts";

export const WORKSPACE_ROOT = "/workspace";

/** What a tool reaches through the connection that runs it. */
export type ToolHost = {
  readonly workspace: Workspace;
  readonly typecheck: (files: ReadonlyArray<WorkspaceFile>) => Promise<CheckResult>;
};

/** A write's before and after, sent as the tool result's `details` and shown to the client as a diff. */
export const FileChange = Schema.Struct({
  path: RelativePath,
  oldText: Schema.optionalKey(Schema.String),
  newText: Schema.String,
});
export type FileChange = typeof FileChange.Type;

type Row<P extends TSchema> = {
  readonly name: string;
  readonly kind: ToolKind;
  readonly description: string;
  readonly parameters: P;
  /** Whether Pi may run an eviction-interrupted call again. */
  readonly replay: "safe" | "unsafe";
  readonly run: (args: Static<P>, host: ToolHost) => Promise<ToolExecutionResult>;
};

const row = <P extends TSchema>(tool: Row<P>) => ({
  name: tool.name,
  kind: tool.kind,
  register: (host: ToolHost): ToolRegistration<P> => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay: tool.replay,
    execute: (args) => tool.run(args, host),
  }),
});

const decodePath = Schema.decodeUnknownSync(RelativePath);

const absolute = (path: string): string => `${WORKSPACE_ROOT}/${decodePath(path)}`;

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

const write = async (
  host: ToolHost,
  path: string,
  newText: string,
): Promise<ToolExecutionResult> => {
  const target = absolute(path);
  const oldText = await readIfPresent(host.workspace, target);
  await host.workspace.fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  await host.workspace.fs.writeFile(target, newText);
  const change: FileChange = {
    path: decodePath(path),
    ...(oldText === undefined ? {} : { oldText }),
    newText,
  };
  return { ...text(`${oldText === undefined ? "Created" : "Updated"} ${path}`), details: change };
};

const workspaceFiles = async (workspace: Workspace): Promise<ReadonlyArray<WorkspaceFile>> => {
  const entries = await workspace.fs.find(WORKSPACE_ROOT, "**/*");
  return Promise.all(
    entries
      .filter((entry) => entry.type === "file")
      .map(async (entry) => ({
        path: decodePath(relative(entry.path)),
        content: await workspace.fs.readFile(entry.path, "utf8"),
      })),
  );
};

const formatDiagnostic = (d: Diagnostic): string =>
  `${d.path}:${d.line}:${d.column} ${d.severity} ${d.code} ${d.message} (${d.tool})`;

const Path = Type.String({ description: "Path relative to the workspace root, such as src/a.ts" });

/** Every tool the agent offers the model. Shell and git join as rows here. */
const TOOLS = [
  row({
    name: "read_file",
    kind: "read",
    description: "Read a UTF-8 text file from the workspace.",
    parameters: Type.Object({ path: Path }),
    replay: "safe",
    run: async ({ path }, { workspace }) =>
      text(await workspace.fs.readFile(absolute(path), "utf8")),
  }),
  row({
    name: "write_file",
    kind: "edit",
    description: "Create or replace a whole file in the workspace.",
    parameters: Type.Object({ path: Path, content: Type.String() }),
    replay: "safe",
    run: ({ path, content }, host) => write(host, path, content),
  }),
  row({
    name: "edit_file",
    kind: "edit",
    description: "Replace the one occurrence of oldText with newText in a workspace file.",
    parameters: Type.Object({ path: Path, oldText: Type.String(), newText: Type.String() }),
    // A rerun would not find oldText it already replaced.
    replay: "unsafe",
    run: async ({ path, oldText, newText }, host) => {
      const current = await host.workspace.fs.readFile(absolute(path), "utf8");
      const at = current.indexOf(oldText);
      if (at === -1 || current.indexOf(oldText, at + 1) !== -1) {
        throw new Error(`oldText must occur exactly once in ${path}`);
      }
      return write(host, path, current.slice(0, at) + newText + current.slice(at + oldText.length));
    },
  }),
  row({
    name: "list_files",
    kind: "search",
    description: "List the files under a workspace directory, or the whole workspace.",
    parameters: Type.Object({ path: Type.Optional(Path) }),
    replay: "safe",
    run: async ({ path }, { workspace }) => {
      const entries = await workspace.fs.find(
        path === undefined ? WORKSPACE_ROOT : absolute(path),
        "**/*",
      );
      const files = entries.filter((entry) => entry.type === "file").map((e) => relative(e.path));
      return text(files.length === 0 ? "No files." : files.join("\n"));
    },
  }),
  row({
    name: "grep",
    kind: "search",
    description: "Search workspace files for a regular expression.",
    parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Path) }),
    replay: "safe",
    run: async ({ pattern, path }, { workspace }) => {
      const matches = await workspace.fs.grep(
        pattern,
        path === undefined ? WORKSPACE_ROOT : absolute(path),
        { regex: true, limit: 200 },
      );
      return text(
        matches.length === 0
          ? "No matches."
          : matches.map((m) => `${relative(m.path)}:${m.line}: ${m.text}`).join("\n"),
      );
    },
  }),
  row({
    name: "typecheck",
    kind: "execute",
    description: "Type-check and lint the workspace with tsrs and oxlint.",
    parameters: Type.Object({}),
    replay: "safe",
    run: async (_args, host) => {
      const result = await host.typecheck(await workspaceFiles(host.workspace));
      return text(
        result.diagnostics.length === 0
          ? "No diagnostics."
          : result.diagnostics.map(formatDiagnostic).join("\n"),
      );
    },
  }),
];

export const toolKind = (name: string): ToolKind =>
  TOOLS.find((tool) => tool.name === name)?.kind ?? "other";

export const registerTools = (host: ToolHost): ToolRegistration[] =>
  TOOLS.map((tool) => tool.register(host));
