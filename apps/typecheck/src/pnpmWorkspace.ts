import * as Predicate from "effect/Predicate";
import * as Yaml from "yaml";

// Settings that shape resolution and that the lockfile records, so a frozen install needs them.
// None names a path: pnpm takes most settings from this file, and modulesDir or virtualStoreDir
// there would write outside the install's directory.
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
    ].filter(([, value]) => value !== undefined),
  );
  return Yaml.stringify(kept);
};
