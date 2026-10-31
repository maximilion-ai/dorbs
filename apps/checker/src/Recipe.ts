import type { CheckId } from "@dorbs/protocol/checker";
import type { RelativePath } from "@dorbs/protocol/typecheck";

/** The images the service builds, one per ecosystem: dorbs-checker/<ecosystem>:1. */
export type Ecosystem = "node" | "python" | "rust" | "go";

/**
 * How a check's output turns into diagnostics. `text` reads what repos' own scripts print: tsc,
 * svelte-check, eslint's stylish, prettier --check, GitHub annotations and file:line:col lines.
 */
export type DiagnosticFormat =
  | "text"
  | "eslint-json"
  | "oxlint-json"
  | "pyright-json"
  | "ruff-json"
  | "cargo-json"
  | "go-vet-json";

/** A shell command run with `sh -c` in the environment's container, from `cwd` under the repo root. */
export type Command = {
  readonly run: string;
  readonly cwd: RelativePath | ".";
};

/**
 * online: first, with the network, in a tree of the manifests and lockfiles alone, for downloads.
 * offline: then on the full tree without network, for installs from them and builds.
 * online-with-source: both, before the offline steps; only the operator's registration may ask.
 */
export type Phase = "online" | "offline" | "online-with-source";

export type SetupStep = Command & {
  readonly id: string;
  readonly phase: Phase;
};

export type Check = Command & {
  readonly id: CheckId;
  readonly format: DiagnosticFormat;
  /** repo runs over the whole repo; changed appends the changed files' paths and is skipped without any. */
  readonly scope: "repo" | "changed";
};

/**
 * How a test request becomes a command. files: the files follow `run`. packages: their Go packages
 * follow, ./... without files. workspace: one run per package of the files, `{dir}` in `run` naming
 * it and the files relative to it following; package: the same, with files outside every package run
 * from the root. filter: the runner takes only a name filter.
 */
export type TestCommand = Command & {
  readonly target: "files" | "packages" | "workspace" | "package" | "filter";
  /** The flag before a name filter, such as -t: empty when it is positional, undefined without filters. */
  readonly filterFlag: string | undefined;
};

/** How to set up, check and test one repo, detected from its files or read from .dorbs/check.json. */
export type Recipe = {
  readonly image: Ecosystem;
  /** The files whose content the environment depends on: lockfiles, manifests, the recipe file. */
  readonly keyFiles: ReadonlyArray<RelativePath>;
  readonly setup: ReadonlyArray<SetupStep>;
  readonly checks: ReadonlyArray<Check>;
  readonly test: TestCommand | undefined;
  /** What detection found, for the operator: package manager, TypeScript version and the like. */
  readonly notes: ReadonlyArray<string>;
};

/** A repo's files at one commit with a change laid over them. */
export type RepoView = {
  readonly paths: ReadonlyArray<RelativePath>;
  readonly read: (path: string) => string | undefined;
};
