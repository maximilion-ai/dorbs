import * as NodePath from "node:path";

/**
 * Whether `target`, a path written in the repo file `from`, names something outside the repo.
 * A backslash counts as outside, since no check can tell how a tool splits it.
 */
export const leavesRepo = (from: string, target: string): boolean => {
  if (target.includes("\\") || NodePath.posix.isAbsolute(target)) return true;
  // TypeScript expands ${configDir} to the directory of the config that names it.
  const joined = NodePath.posix.join(
    NodePath.posix.dirname(from),
    target.replace(/^\$\{configDir\}/, "."),
  );
  return joined === ".." || joined.startsWith("../");
};

/**
 * Whether the module specifier `specifier`, written in the repo file `from`, can resolve outside
 * the repo by its spelling alone: absolute, a file URL, relative past the root,
 * or a package path with `..`.
 */
export const specifierLeavesRepo = (from: string, specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../") || specifier === ".."
    ? leavesRepo(from, specifier)
    : specifier.includes("\\") ||
      NodePath.posix.isAbsolute(specifier) ||
      /^(?:[A-Za-z]:|file:)/i.test(specifier) ||
      specifier.split("/").includes("..");
