import type { CheckId } from "@dorbs/protocol/checker";
import type { RelativePath } from "@dorbs/protocol/typecheck";

/** The images the service builds, one per ecosystem: dorbs-checker/<ecosystem>:1. */
export type Ecosystem = "node" | "python" | "rust" | "go";
export const ECOSYSTEMS: ReadonlyArray<Ecosystem> = ["node", "python", "rust", "go"];

/**
 * How a check's output turns into diagnostics. `text` reads the line formats of tsc, svelte-check,
 * eslint's stylish, prettier --check, GitHub annotations and file:line:col compilers, which is what a
 * repo's own script prints.
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

export type SetupStep = Command & {
  readonly id: string;
  /** Whether the step reaches the network, as an install must. Steps that run repo code get none. */
  readonly network: boolean;
};

export type Check = Command & {
  readonly id: CheckId;
  readonly format: DiagnosticFormat;
  /** repo runs over the whole repo; changed appends the changed files' paths and is skipped without any. */
  readonly scope: "repo" | "changed";
};

/**
 * How a test request becomes a command. The runner's summary gives the counts, whichever runner it is.
 * - files: the files follow `run`.
 * - packages: Go's packages of the files, such as ./pkg/x, follow `run`; ./... without files.
 * - workspace: one run per workspace package of the files, `{dir}` in `run` naming it and the files,
 *   relative to it, following.
 * - filter: the runner takes no files, only the filter.
 */
export type TestCommand = Command & {
  readonly target: "files" | "packages" | "workspace" | "filter";
  /** The flag before a name filter, such as -t; empty when the filter is positional, as cargo's is. */
  readonly filterFlag: string;
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
