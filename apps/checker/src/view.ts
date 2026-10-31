import type { Change } from "@dorbs/protocol/checker";
import type { RelativePath } from "@dorbs/protocol/typecheck";

import { isFetchInput } from "./detect.ts";
import type { RepoView } from "./Recipe.ts";

const OVERRIDE = ".dorbs/check.json";

/**
 * Files that steer how setup runs rather than what it installs: the recipe and package manager
 * configuration, which can run code or point installs elsewhere. Setup reaches the network, so these
 * come from the commit, which only those who can push choose; a change to them applies to checks only.
 */
const isCommitOnly = (path: string): boolean =>
  [
    OVERRIDE,
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".pnpmfile.cjs",
    "bunfig.toml",
    ".cargo/config.toml",
    ".cargo/config",
    "setup.py",
    "setup.cfg",
    "rust-toolchain",
    "rust-toolchain.toml",
  ].includes(path) || path.startsWith(".yarn/");

/** The commit's files with the change laid over them, as detection and the environment key see them. */
export const viewOf = (
  paths: ReadonlyArray<RelativePath>,
  inputs: ReadonlyMap<string, string>,
  change: Change,
  operatorRecipe: string | undefined,
): RepoView => {
  const files = new Map(inputs);
  const deleted = new Set<string>(change.deleted.filter((path) => !isCommitOnly(path)));
  const written = change.files.filter((file) => !isCommitOnly(file.path));
  for (const path of deleted) files.delete(path);
  for (const file of written) files.set(file.path, file.content);
  if (operatorRecipe !== undefined) files.set(OVERRIDE, operatorRecipe);
  const all = new Set<RelativePath>([
    ...paths.filter((path) => !deleted.has(path)),
    ...written.map((file) => file.path),
  ]);
  return { paths: [...all].toSorted(), read: (path) => files.get(path) };
};

/** The part of a change laid over the commit while setup runs: its key files that may change. */
export const setupChange = (change: Change, keyFiles: ReadonlySet<string>): Change => ({
  files: change.files.filter((file) => keyFiles.has(file.path) && !isCommitOnly(file.path)),
  deleted: change.deleted.filter((path) => keyFiles.has(path) && !isCommitOnly(path)),
});

/** The tree the online setup steps see: the commit's files at `paths`, and `change` over them. */
export type FetchTree = {
  readonly paths: ReadonlyArray<RelativePath>;
  readonly change: Change;
};

/**
 * The key files that downloads need, the change's over the commit's, and an empty file in place of
 * each Rust source, since cargo refuses a manifest whose targets are missing.
 */
export const fetchTree = (
  commitPaths: ReadonlyArray<RelativePath>,
  view: RepoView,
  keyFiles: ReadonlyArray<RelativePath>,
  keyChange: Change,
): FetchTree => {
  const fetched = new Set<string>(keyFiles.filter(isFetchInput));
  return {
    paths: commitPaths.filter((path) => fetched.has(path)),
    change: {
      files: [
        ...keyChange.files.filter((file) => fetched.has(file.path)),
        ...view.paths.filter((path) => path.endsWith(".rs")).map((path) => ({ path, content: "" })),
      ],
      deleted: keyChange.deleted.filter((path) => fetched.has(path)),
    },
  };
};
