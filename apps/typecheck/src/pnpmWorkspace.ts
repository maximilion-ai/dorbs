import * as Predicate from "effect/Predicate";
import * as Yaml from "yaml";

// Settings that shape resolution and that the lockfile records, so a frozen install needs them.
// None names a path: pnpm takes most settings from this file, and modulesDir or virtualStoreDir
// there would write outside the install's directory. patchedDependencies, which does, keeps only
// the entries `patchFiles` passes.
const KEPT = [
  "catalog",
  "catalogs",
  "overrides",
  "packageExtensions",
  "peerDependencyRules",
  "autoInstallPeers",
  "excludeLinksFromLockfile",
  "injectWorkspacePackages",
  "dedupePeerDependents",
];

// Plain path characters only, so no brace, bracket or escape can spell `..` another way.
const PLAIN_GLOB = /^!?[A-Za-z0-9._@*/-]+$/;

const insideRoot = (glob: string): boolean => {
  const path = glob.replace(/^!/, "");
  return PLAIN_GLOB.test(glob) && !path.startsWith("/") && !path.split("/").includes("..");
};

const fieldOf = (value: unknown, key: string): unknown =>
  Predicate.hasProperty(value, key) ? value[key] : undefined;

// A .patch file in the repo, through no dot-named directory or node_modules, so no patch path can
// stage a config file pnpm reads, such as .npmrc, or a file outside the staging dir.
const SEGMENT = "[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*";
const PATCH = new RegExp(`^(?:${SEGMENT}/)*${SEGMENT}\\.patch$`);

const isPatch = (key: string, value: unknown): value is string =>
  key !== "<<" &&
  typeof value === "string" &&
  PATCH.test(value) &&
  !value.split("/").includes("node_modules");

const entries = (value: unknown): ReadonlyArray<readonly [string, unknown]> =>
  Predicate.isObject(value) ? Object.entries(value) : [];

const parse = (text: string | undefined, parser: (text: string) => unknown): unknown => {
  try {
    return text === undefined ? undefined : parser(text);
  } catch {
    return undefined;
  }
};

/**
 * The patch files that the root package.json's `pnpm.patchedDependencies` and pnpm-workspace.yaml's
 * `patchedDependencies` name, which pnpm reads during a frozen install, and as `key: value` each
 * entry that is not a plain .patch path in the repo.
 */
export const patchFiles = (
  manifest: string | undefined,
  workspace: string | undefined,
): { readonly files: ReadonlyArray<string>; readonly refused: ReadonlyArray<string> } => {
  const all = [
    ...entries(fieldOf(fieldOf(parse(manifest, JSON.parse), "pnpm"), "patchedDependencies")),
    ...entries(fieldOf(parse(workspace, Yaml.parse), "patchedDependencies")),
  ];
  return {
    files: all.flatMap(([key, value]) => (isPatch(key, value) ? [value] : [])),
    refused: all
      .filter(([key, value]) => !isPatch(key, value))
      .map(
        ([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
      ),
  };
};

/** The commit's pnpm-workspace.yaml cut down to the settings a shared install may take from it. */
export const installWorkspace = (text: string): string => {
  const parsed: unknown = Yaml.parse(text);
  const field = (key: string): unknown =>
    Predicate.hasProperty(parsed, key) ? parsed[key] : undefined;
  const packages = field("packages");
  const kept = Object.fromEntries(
    [
      [
        "packages",
        Array.isArray(packages)
          ? packages.filter((glob): glob is string => typeof glob === "string" && insideRoot(glob))
          : undefined,
      ] as const,
      ...KEPT.map((key) => [key, field(key)] as const),
      [
        "patchedDependencies",
        field("patchedDependencies") === undefined
          ? undefined
          : Object.fromEntries(
              entries(field("patchedDependencies")).filter(([key, value]) => isPatch(key, value)),
            ),
      ] as const,
    ].filter(([, value]) => value !== undefined),
  );
  return Yaml.stringify(kept);
};
