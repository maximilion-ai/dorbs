import * as Schema from "effect/Schema";

import { CheckId } from "@dorbs/protocol/checker";
import { RelativePath } from "@dorbs/protocol/typecheck";

import type {
  Check,
  Command,
  DiagnosticFormat,
  Ecosystem,
  Recipe,
  RepoView,
  SetupStep,
  TestCommand,
} from "./Recipe.ts";

const OVERRIDE = ".dorbs/check.json";
const ROOT = ".";

type Detected = Omit<Recipe, "keyFiles"> & { readonly keyFiles: ReadonlyArray<string> };

const step = (id: string, run: string, network: boolean, cwd = ROOT): SetupStep => ({
  id,
  run,
  cwd: cwd === ROOT ? ROOT : RelativePath.make(cwd),
  network,
});

const check = (id: string, run: string, format: DiagnosticFormat): Check => ({
  id: CheckId.make(id),
  run,
  cwd: ROOT,
  format,
  scope: "repo",
});

const parseJson = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

type Manifest = {
  readonly packageManager: string | undefined;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: ReadonlySet<string>;
  readonly workspaces: ReadonlyArray<string>;
};

const manifest = (text: string | undefined): Manifest => {
  const json = parseJson(text);
  const record = isRecord(json) ? json : {};
  const scripts = isRecord(record.scripts) ? record.scripts : {};
  const dependencies = ["dependencies", "devDependencies", "optionalDependencies"].flatMap(
    (field) => {
      const deps = record[field];
      return isRecord(deps) ? Object.keys(deps) : [];
    },
  );
  const workspaces = isRecord(record.workspaces)
    ? strings(record.workspaces.packages)
    : strings(record.workspaces);
  return {
    packageManager: typeof record.packageManager === "string" ? record.packageManager : undefined,
    scripts: Object.fromEntries(
      Object.entries(scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    dependencies: new Set(dependencies),
    workspaces,
  };
};

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ROOT);
const named = (paths: ReadonlyArray<string>, name: string) =>
  paths.filter(
    (path) => (path.split("/").at(-1) ?? "") === name && !path.split("/").includes("node_modules"),
  );

/** A workspace glob such as packages/* or apps/**, as a regex over directory paths. */
const globRegex = (glob: string): RegExp => {
  const body = glob
    .replace(/^\.\//, "")
    .replace(/\/$/, "")
    .split("/")
    .map((segment) =>
      segment === "**"
        ? "(?:[^/]+/)*?[^/]+"
        : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
    )
    .join("/");
  return new RegExp(`^${body}$`);
};

/** The workspace's package directories, the root first, from pnpm-workspace.yaml or `workspaces`. */
export const workspacePackages = (repo: RepoView): ReadonlyArray<string> =>
  workspaceDirs(repo, manifest(repo.read("package.json")));

const workspaceDirs = (repo: RepoView, root: Manifest): ReadonlyArray<string> => {
  const yaml = repo.read("pnpm-workspace.yaml");
  const globs =
    yaml === undefined
      ? root.workspaces
      : [
          ...(/^packages:\s*\n((?:[ \t]+-.*\n?|[ \t]*#.*\n?)*)/m.exec(yaml)?.[1] ?? "").matchAll(
            /^[ \t]+-[ \t]*["']?([^"'\n#]+?)["']?[ \t]*(?:#.*)?$/gm,
          ),
        ].map((match) => match[1] ?? "");
  const include = globs.filter((glob) => !glob.startsWith("!")).map(globRegex);
  const exclude = globs
    .filter((glob) => glob.startsWith("!"))
    .map((glob) => globRegex(glob.slice(1)));
  const dirs = named(repo.paths, "package.json")
    .map(dirOf)
    .filter((dir) => dir !== ROOT)
    .filter(
      (dir) =>
        include.some((regex) => regex.test(dir)) && !exclude.some((regex) => regex.test(dir)),
    );
  return [ROOT, ...dirs.toSorted()];
};

type PackageManager = "pnpm" | "yarn" | "yarn-berry" | "npm" | "bun";
const isPackageManager = (name: string): name is PackageManager =>
  ["pnpm", "yarn", "npm", "bun"].includes(name);

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

const packageManager = (repo: RepoView, root: Manifest) => {
  const lockfile = LOCKFILES.find(([file]) => repo.read(file) !== undefined);
  const pinned = /^(pnpm|yarn|npm|bun)@(\d+)/.exec(root.packageManager ?? "");
  const name = pinned?.[1] ?? lockfile?.[1] ?? "npm";
  const berry =
    name === "yarn" &&
    ((pinned !== null && Number(pinned[2]) >= 2) ||
      repo.read(".yarnrc.yml") !== undefined ||
      (repo.read("yarn.lock") ?? "").includes("__metadata:"));
  const manager: PackageManager = berry ? "yarn-berry" : isPackageManager(name) ? name : "npm";
  const note =
    pinned !== null
      ? `${root.packageManager} from packageManager`
      : lockfile !== undefined
        ? `${manager} from ${lockfile[0]}`
        : "npm, since there is no lockfile";
  return { manager, lockfile: lockfile?.[0], note };
};

const install = (manager: PackageManager, locked: boolean): string =>
  ({
    pnpm: `pnpm install${locked ? " --frozen-lockfile" : ""} --ignore-scripts --ignore-pnpmfile`,
    yarn: `yarn install${locked ? " --frozen-lockfile" : ""} --ignore-scripts --non-interactive`,
    "yarn-berry": `yarn install${locked ? " --immutable" : ""} --mode=skip-build`,
    npm: locked
      ? "npm ci --ignore-scripts --no-audit --no-fund"
      : "npm install --ignore-scripts --no-audit --no-fund",
    bun: `bun install${locked ? " --frozen-lockfile" : ""} --ignore-scripts`,
  })[manager];

const runScript = (manager: PackageManager, script: string): string =>
  manager === "npm"
    ? `npm run ${script}`
    : `${manager === "yarn-berry" ? "yarn" : manager} run ${script}`;

/** A package binary, run the way the manager finds it. */
const exec = (manager: PackageManager, bin: string): string =>
  ({
    pnpm: `pnpm exec ${bin}`,
    yarn: `yarn ${bin}`,
    "yarn-berry": `yarn ${bin}`,
    npm: `node_modules/.bin/${bin}`,
    bun: `node_modules/.bin/${bin}`,
  })[manager];

/** The TypeScript version the lockfile pins, if it pins one. */
const typescriptVersion = (repo: RepoView, lockfile: string | undefined): string | undefined => {
  const text = lockfile === undefined ? "" : (repo.read(lockfile) ?? "");
  const patterns = [
    /(?:^|[\s/"])typescript@(\d+\.\d+\.\d+[^\s:'"(]*)/m,
    /"node_modules\/typescript":\s*\{[^}]*?"version":\s*"([^"]+)"/,
    /^"?typescript@[^\n]*:\n\s+version:?\s+"?([^"\n]+)"?/m,
  ];
  for (const pattern of patterns) {
    const version = pattern.exec(text)?.[1];
    if (version !== undefined) return version;
  }
  return undefined;
};

const TYPECHECK_SCRIPTS = [
  "typecheck",
  "type-check",
  "check:type",
  "check:types",
  "check-types",
  "types:check",
  "tsc",
];

const ESLINT_FLAT = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
];
const ESLINT_LEGACY = [
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
];

const nodeChecks = (
  repo: RepoView,
  root: Manifest,
  manager: PackageManager,
  typescript: boolean,
) => {
  const checks: Array<Check> = [];
  const typecheck = TYPECHECK_SCRIPTS.find((name) => root.scripts[name] !== undefined);
  if (typecheck !== undefined) checks.push(check(typecheck, runScript(manager, typecheck), "text"));
  const checkScript = typecheck === undefined ? root.scripts.check : undefined;
  if (checkScript !== undefined) checks.push(check("check", runScript(manager, "check"), "text"));
  // A check script may only format or lint; tsc covers the types then, unless the script type-checks
  // itself or hands off to the workspace's packages, whose own scripts may.
  const typed =
    checkScript !== undefined && (TYPE_CHECKERS.test(checkScript) || DELEGATING.test(checkScript));
  if (typecheck === undefined && !typed && typescript && repo.read("tsconfig.json") !== undefined) {
    const tsconfig = parseJson(repo.read("tsconfig.json"));
    const references =
      isRecord(tsconfig) && Array.isArray(tsconfig.references) && tsconfig.references.length > 0;
    const args = references ? "-b --pretty false" : "--noEmit -p tsconfig.json --pretty false";
    checks.push(check("tsc", `${exec(manager, "tsc")} ${args}`, "text"));
  }
  if (root.scripts.lint !== undefined) {
    checks.push(check("lint", runScript(manager, "lint"), "text"));
    return checks;
  }
  const flat = ESLINT_FLAT.some((file) => repo.read(file) !== undefined);
  const legacy = ESLINT_LEGACY.some((file) => repo.read(file) !== undefined);
  if (flat || legacy) {
    const extensions = legacy && !flat ? " --ext .js,.jsx,.ts,.tsx,.mjs,.cjs,.mts,.cts" : "";
    checks.push(
      check("eslint", `${exec(manager, "eslint")} . --format json${extensions}`, "eslint-json"),
    );
  } else if (repo.read("biome.json") !== undefined || repo.read("biome.jsonc") !== undefined) {
    checks.push(check("biome", `${exec(manager, "biome")} lint --reporter=github .`, "text"));
  } else if (repo.read(".oxlintrc.json") !== undefined || root.dependencies.has("oxlint")) {
    checks.push(check("oxlint", `${exec(manager, "oxlint")} --format json`, "oxlint-json"));
  }
  return checks;
};

const DELEGATING =
  /--workspaces|\s-ws\b|\s-r\b|--recursive|--parallel|\bturbo\b|\bnx\b|--filter|\s-F\s/;
const TYPE_CHECKERS = /\b(?:tsc|tsgo|tsrs|svelte-check|vue-tsc|astro check|typecheck|type-check)\b/;

const nodeTest = (
  repo: RepoView,
  root: Manifest,
  manager: PackageManager,
  dirs: ReadonlyArray<string>,
): TestCommand | undefined => {
  const script = root.scripts.test ?? "";
  const files = (run: string, filterFlag: string | undefined): TestCommand => ({
    run,
    cwd: ROOT,
    target: "files",
    filterFlag,
  });
  // In a workspace a runner runs from the package of each file, where that package's config is.
  const runner = (bin: string, args: string): TestCommand =>
    dirs.length > 1
      ? {
          run: `cd {dir} && ${manager === "npm" || manager === "bun" ? `npx --no-install ${bin}` : exec(manager, bin)}${args}`,
          cwd: ROOT,
          target: "package",
          filterFlag: "-t",
        }
      : files(`${exec(manager, bin)}${args}`, "-t");
  if (root.dependencies.has("vitest") || /\bvitest\b/.test(script)) return runner("vitest", " run");
  if (root.dependencies.has("jest") || /\bjest\b/.test(script)) return runner("jest", "");
  const node = /\bnode((?:\s+--?[\w-]+(?:=\S+)?)*)\s+--test\b((?:\s+--?[\w-]+(?:=\S+)?)*)/.exec(
    script,
  );
  if (node !== null)
    return files(`node${node[1] ?? ""} --test${node[2] ?? ""}`, "--test-name-pattern");
  if (script === "") return undefined;
  const members = dirs.filter(
    (dir) => dir !== ROOT && manifest(repo.read(`${dir}/package.json`)).scripts.test !== undefined,
  );
  if (DELEGATING.test(script) && members.length > 0) {
    const run = {
      pnpm: "pnpm --dir {dir} run test",
      npm: "npm test -w {dir} --",
      yarn: "yarn --cwd {dir} run test",
      "yarn-berry": "yarn --cwd {dir} run test",
      bun: "bun run --cwd {dir} test",
    }[manager];
    return { run, cwd: ROOT, target: "workspace", filterFlag: undefined };
  }
  return files(manager === "npm" ? "npm test --" : runScript(manager, "test"), undefined);
};

const nodeKeyFiles = (repo: RepoView): ReadonlyArray<string> =>
  repo.paths.filter((path) => {
    const names = path.split("/");
    if (names.includes("node_modules")) return false;
    const name = names.at(-1) ?? "";
    return (
      name === "package.json" ||
      (names.length === 1 &&
        [
          ...LOCKFILES.map(([file]) => file),
          "pnpm-workspace.yaml",
          ".npmrc",
          ".yarnrc",
          ".yarnrc.yml",
          "bunfig.toml",
        ].includes(name)) ||
      path.startsWith("patches/") ||
      path.startsWith(".yarn/releases/") ||
      path.startsWith(".yarn/plugins/") ||
      path.startsWith(".yarn/patches/")
    );
  });

const detectNode = (repo: RepoView): Detected | undefined => {
  const text = repo.read("package.json");
  if (text === undefined) return undefined;
  const root = manifest(text);
  const { manager, lockfile, note } = packageManager(repo, root);
  const version = typescriptVersion(repo, lockfile);
  const dirs = workspaceDirs(repo, root);
  const typescript =
    version !== undefined ||
    dirs.some((dir) =>
      manifest(repo.read(dir === ROOT ? "package.json" : `${dir}/package.json`)).dependencies.has(
        "typescript",
      ),
    );
  const kits = dirs.filter((dir) =>
    manifest(repo.read(dir === ROOT ? "package.json" : `${dir}/package.json`)).dependencies.has(
      "@sveltejs/kit",
    ),
  );
  return {
    image: "node",
    keyFiles: nodeKeyFiles(repo),
    setup: [
      step("install", install(manager, lockfile !== undefined), true),
      ...kits.map((dir) =>
        step(
          dir === ROOT ? "svelte-kit sync" : `svelte-kit sync ${dir}`,
          exec(manager, "svelte-kit sync"),
          false,
          dir,
        ),
      ),
    ],
    checks: nodeChecks(repo, root, manager, typescript),
    test: nodeTest(repo, root, manager, dirs),
    notes: [note, ...(version === undefined ? [] : [`typescript ${version}`])],
  };
};

const PYTHON_ROOTS = ["pyproject.toml", "requirements.txt", "setup.py"];

const detectPython = (repo: RepoView): Detected | undefined => {
  const requirements = repo.paths
    .filter((path) => /^requirements[\w.-]*\.txt$/.test(path))
    .toSorted();
  if (!PYTHON_ROOTS.some((file) => repo.read(file) !== undefined) && requirements.length === 0)
    return undefined;
  const pyproject = repo.read("pyproject.toml") ?? "";
  const locked = repo.read("uv.lock") !== undefined;
  const deps = [
    pyproject,
    repo.read("uv.lock") ?? "",
    ...requirements.map((file) => repo.read(file) ?? ""),
  ].join("\n");
  const has = (name: string) =>
    new RegExp(`(?:^|[\\s"'=])${name}(?:[\\s"'=<>~!\\[;,]|$)`, "m").test(deps);
  const workspace = /^\[tool\.uv\.workspace\]/m.test(pyproject) ? " --all-packages" : "";
  const install =
    pyproject !== "" || locked
      ? `uv sync${locked ? " --frozen" : ""} --all-extras --all-groups${workspace}`
      : `uv venv && uv pip install ${requirements.map((file) => `-r ${file}`).join(" ")}`;
  const setup = [step("install", install, true)];
  const checks: Array<Check> = [];
  if (has("basedpyright")) {
    checks.push(check("basedpyright", ".venv/bin/basedpyright --outputjson", "pyright-json"));
  } else if (has("pyright")) {
    // The pyright wheel downloads Node and pyright itself on its first run.
    setup.push(step("pyright", ".venv/bin/pyright --version", true));
    checks.push(check("pyright", ".venv/bin/pyright --outputjson", "pyright-json"));
  }
  if (has("mypy") && (/^\[tool\.mypy\]/m.test(pyproject) || repo.read("mypy.ini") !== undefined)) {
    checks.push(check("mypy", ".venv/bin/mypy", "text"));
  }
  if (has("ruff"))
    checks.push(check("ruff", ".venv/bin/ruff check --output-format json .", "ruff-json"));
  return {
    image: "python",
    keyFiles: repo.paths.filter(
      (path) =>
        (path.split("/").at(-1) ?? "") === "pyproject.toml" ||
        requirements.includes(path) ||
        ["uv.lock", ".python-version", "setup.py", "setup.cfg", "mypy.ini"].includes(path),
    ),
    setup,
    checks,
    test: has("pytest")
      ? {
          run: ".venv/bin/python -m pytest -q -p no:cacheprovider",
          cwd: ROOT,
          target: "files",
          filterFlag: "-k",
        }
      : undefined,
    notes: [
      locked
        ? "uv.lock"
        : pyproject !== ""
          ? "pyproject.toml without uv.lock"
          : "requirements files",
    ],
  };
};

const detectRust = (repo: RepoView): Detected | undefined => {
  if (repo.read("Cargo.toml") === undefined) return undefined;
  const locked = repo.read("Cargo.lock") !== undefined ? " --locked" : "";
  return {
    image: "rust",
    keyFiles: repo.paths.filter(
      (path) =>
        (path.split("/").at(-1) ?? "") === "Cargo.toml" ||
        ["Cargo.lock", "rust-toolchain", "rust-toolchain.toml", ".cargo/config.toml"].includes(
          path,
        ),
    ),
    setup: [step("fetch", `cargo fetch${locked}`, true)],
    checks: [
      check(
        "cargo-check",
        `cargo check --workspace --all-targets --offline${locked} --message-format json`,
        "cargo-json",
      ),
    ],
    test: {
      run: `cargo test --workspace --offline${locked}`,
      cwd: ROOT,
      target: "filter",
      filterFlag: "",
    },
    notes: [],
  };
};

const detectGo = (repo: RepoView): Detected | undefined => {
  if (repo.read("go.mod") === undefined) return undefined;
  return {
    image: "go",
    keyFiles: repo.paths.filter((path) =>
      ["go.mod", "go.sum", "go.work", "go.work.sum"].includes(path.split("/").at(-1) ?? ""),
    ),
    setup: [step("download", "go mod download", true)],
    checks: [
      check("go-build", "go build ./...", "text"),
      check("go-vet", "go vet -json ./...", "go-vet-json"),
    ],
    test: { run: "go test -v", cwd: ROOT, target: "packages", filterFlag: "-run" },
    notes: [],
  };
};

const Cwd = Schema.optionalKey(Schema.Union([Schema.Literal(ROOT), RelativePath]));
const Format = Schema.Literals([
  "text",
  "eslint-json",
  "oxlint-json",
  "pyright-json",
  "ruff-json",
  "cargo-json",
  "go-vet-json",
]);

/** .dorbs/check.json: each field present replaces what detection found; keyFiles add to it. */
const Override = Schema.Struct({
  image: Schema.optionalKey(Schema.Literals(["node", "python", "rust", "go"])),
  setup: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.NonEmptyString,
        run: Schema.NonEmptyString,
        cwd: Cwd,
        network: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
  checks: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: CheckId,
        run: Schema.NonEmptyString,
        cwd: Cwd,
        format: Schema.optionalKey(Format),
        scope: Schema.optionalKey(Schema.Literals(["repo", "changed"])),
      }),
    ),
  ),
  test: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        run: Schema.NonEmptyString,
        cwd: Cwd,
        target: Schema.optionalKey(
          Schema.Literals(["files", "packages", "workspace", "package", "filter"]),
        ),
        filterFlag: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  keyFiles: Schema.optionalKey(Schema.Array(RelativePath)),
});
const decodeOverride = Schema.decodeUnknownResult(Schema.fromJsonString(Override));

const ROOT_INPUTS = new Set([
  ...LOCKFILES.map(([file]) => file),
  "pnpm-workspace.yaml",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
  "tsconfig.json",
  ...ESLINT_FLAT,
  ...ESLINT_LEGACY,
  "biome.json",
  "biome.jsonc",
  ".oxlintrc.json",
  "uv.lock",
  ".python-version",
  "setup.py",
  "setup.cfg",
  "mypy.ini",
  "Cargo.lock",
  "rust-toolchain",
  "rust-toolchain.toml",
  ".cargo/config.toml",
  OVERRIDE,
]);
const NESTED_INPUTS = new Set([
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
]);

/** Whether detection may read `path`, so the service reads only these files of a commit. */
export const isDetectionInput = (path: string): boolean => {
  const names = path.split("/");
  if (names.includes("node_modules")) return false;
  return (
    ROOT_INPUTS.has(path) ||
    NESTED_INPUTS.has(names.at(-1) ?? "") ||
    /^requirements[\w.-]*\.txt$/.test(path) ||
    /^(?:patches|\.yarn\/(?:releases|plugins|patches))\//.test(path)
  );
};

const DETECTORS: ReadonlyArray<(repo: RepoView) => Detected | undefined> = [
  detectNode,
  detectPython,
  detectRust,
  detectGo,
];

const toRecipe = (detected: Detected): Recipe => ({
  ...detected,
  keyFiles: [...new Set(detected.keyFiles)].toSorted().map((path) => RelativePath.make(path)),
});

/**
 * The recipe for a repo: the first ecosystem, in the order node, python, rust, go, whose detection
 * finds a check, else the first found at all, with .dorbs/check.json laid over it.
 */
export const detect = (repo: RepoView): Recipe | { readonly reason: string } => {
  const found = DETECTORS.map((detector) => detector(repo)).filter(
    (recipe) => recipe !== undefined,
  );
  const base = found.find((recipe) => recipe.checks.length > 0) ?? found[0];
  const text = repo.read(OVERRIDE);
  if (text === undefined) {
    return base === undefined
      ? {
          reason:
            "No package.json, pyproject.toml, requirements.txt, Cargo.toml or go.mod at the root, and no .dorbs/check.json.",
        }
      : toRecipe(base);
  }
  const decoded = decodeOverride(text);
  if (decoded._tag === "Failure") return { reason: `${OVERRIDE}: ${decoded.failure.message}` };
  const override = decoded.success;
  const image: Ecosystem | undefined = override.image ?? base?.image;
  if (image === undefined)
    return { reason: `${OVERRIDE} names no image and detection found no ecosystem.` };
  const cwd = (command: { readonly cwd?: Command["cwd"] }): Command["cwd"] => command.cwd ?? ROOT;
  const replaced = (["setup", "checks", "test"] as const).filter(
    (field) => override[field] !== undefined,
  );
  return toRecipe({
    image,
    keyFiles: [...(base?.keyFiles ?? []), OVERRIDE, ...(override.keyFiles ?? [])],
    setup:
      override.setup?.map((s) => ({
        id: s.id,
        run: s.run,
        cwd: cwd(s),
        network: s.network ?? false,
      })) ??
      base?.setup ??
      [],
    checks:
      override.checks?.map((c) => ({
        id: c.id,
        run: c.run,
        cwd: cwd(c),
        format: c.format ?? "text",
        scope: c.scope ?? "repo",
      })) ??
      base?.checks ??
      [],
    test:
      override.test === null
        ? undefined
        : override.test === undefined
          ? base?.test
          : {
              run: override.test.run,
              cwd: cwd(override.test),
              target: override.test.target ?? "files",
              filterFlag: override.test.filterFlag,
            },
    notes: [
      ...(base?.notes ?? []),
      ...(replaced.length > 0 ? [`${OVERRIDE} overrides ${replaced.join(", ")}`] : []),
    ],
  });
};
