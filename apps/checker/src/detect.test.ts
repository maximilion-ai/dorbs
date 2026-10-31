import { assert, it } from "@effect/vitest";

import { RelativePath } from "@dorbs/protocol/typecheck";

import { detect } from "./detect.ts";
import type { RepoView } from "./Recipe.ts";

const view = (files: Record<string, string>): RepoView => ({
  paths: Object.keys(files).map((path) => RelativePath.make(path)),
  read: (path) => files[path],
});

const recipe = (files: Record<string, string>) => {
  const detected = detect(view(files));
  if (!("image" in detected)) throw new Error(`no recipe: ${detected.reason}`);
  return detected;
};

const json = (value: unknown) => JSON.stringify(value);

const PNPM_LOCK =
  "lockfileVersion: '9.0'\n\npackages:\n\n  typescript@5.9.3:\n    resolution: {}\n";

it("runs a pnpm repo's own typecheck and lint scripts after a frozen install", () => {
  const detected = recipe({
    "package.json": json({
      packageManager: "pnpm@11.28.6",
      scripts: { typecheck: "tsc -p tsconfig.check.json --noEmit", lint: "oxlint", check: "x" },
      devDependencies: { vitest: "5.0.0" },
    }),
    "pnpm-lock.yaml": PNPM_LOCK,
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/a/package.json": json({ name: "a" }),
    "patches/x.patch": "",
    "test/fixtures/package.json": json({ name: "fixture" }),
    "src/index.ts": "",
  });
  assert.deepStrictEqual(detected, {
    image: "node",
    keyFiles: [
      "package.json",
      "packages/a/package.json",
      "patches/x.patch",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "test/fixtures/package.json",
    ],
    setup: [
      {
        id: "install",
        run: "pnpm install --frozen-lockfile --ignore-scripts",
        cwd: ".",
        network: true,
      },
    ],
    checks: [
      { id: "typecheck", run: "pnpm run typecheck", cwd: ".", format: "text", scope: "repo" },
      { id: "lint", run: "pnpm run lint", cwd: ".", format: "text", scope: "repo" },
    ],
    test: { run: "pnpm exec vitest run", cwd: ".", target: "files", filterFlag: "-t" },
    notes: ["pnpm@11.28.6 from packageManager", "typescript 5.9.3"],
  });
});

it("falls back to the repo's check script, or check:type, when it has no typecheck script", () => {
  const checkOnly = recipe({
    "package.json": json({ scripts: { check: "svelte-check" } }),
    "pnpm-lock.yaml": PNPM_LOCK,
  });
  assert.deepStrictEqual(
    checkOnly.checks.map((check) => check.run),
    ["pnpm run check"],
  );
  const checkType = recipe({
    "package.json": json({ scripts: { check: "everything", "check:type": "turbo typecheck" } }),
    "pnpm-lock.yaml": PNPM_LOCK,
  });
  assert.deepStrictEqual(
    checkType.checks.map((check) => check.id),
    ["check:type"],
  );
});

it("runs tsc -b for project references and eslint with JSON output when the repo has no scripts", () => {
  const detected = recipe({
    "package.json": json({ workspaces: ["packages/*"], devDependencies: { eslint: "9" } }),
    "package-lock.json": json({
      packages: { "node_modules/typescript": { version: "6.0.2" }, "node_modules/eslint": {} },
    }),
    "tsconfig.json": json({ files: [], references: [{ path: "packages/a" }] }),
    "eslint.config.js": "export default [];",
  });
  assert.deepStrictEqual(detected.setup[0]?.run, "npm ci --ignore-scripts --no-audit --no-fund");
  assert.deepStrictEqual(detected.checks, [
    {
      id: "tsc",
      run: "node_modules/.bin/tsc -b --pretty false",
      cwd: ".",
      format: "text",
      scope: "repo",
    },
    {
      id: "eslint",
      run: "node_modules/.bin/eslint . --format json",
      cwd: ".",
      format: "eslint-json",
      scope: "repo",
    },
  ]);
  assert.include(detected.notes, "typescript 6.0.2");
});

it("tells yarn classic from berry and passes legacy eslint the TypeScript extensions", () => {
  const classic = recipe({
    "package.json": json({ packageManager: "yarn@1.22.22" }),
    "yarn.lock":
      '# yarn lockfile v1\n\ntypescript@5.9.3:\n  version "5.9.3"\neslint@8:\n  version "8.57.0"\n',
    "tsconfig.json": json({ compilerOptions: { strict: true } }),
    ".eslintrc.json": "{}",
  });
  assert.deepStrictEqual(
    [classic.setup[0]?.run, ...classic.checks.map((check) => check.run)],
    [
      "yarn install --frozen-lockfile --ignore-scripts --non-interactive",
      "yarn tsc --noEmit -p tsconfig.json --pretty false",
      "yarn eslint . --format json --ext .js,.jsx,.ts,.tsx,.mjs,.cjs,.mts,.cts",
    ],
  );
  const berry = recipe({
    "package.json": json({ scripts: { lint: "eslint ." } }),
    "yarn.lock": "__metadata:\n  version: 8\n",
    ".yarnrc.yml": "yarnPath: .yarn/releases/yarn-4.5.0.cjs\n",
    ".yarn/releases/yarn-4.5.0.cjs": "",
  });
  assert.deepStrictEqual(berry.setup[0]?.run, "yarn install --immutable --mode=skip-build");
  assert.deepStrictEqual(berry.checks[0]?.run, "yarn run lint");
  assert.includeMembers(berry.keyFiles, [".yarnrc.yml", ".yarn/releases/yarn-4.5.0.cjs"]);
});

it("installs a bun repo with bun", () => {
  const detected = recipe({
    "package.json": json({ scripts: { test: "bun test" } }),
    "bun.lock": '{ "packages": { "typescript": ["typescript@5.9.3", ""] } }',
    "tsconfig.json": "{}",
  });
  assert.deepStrictEqual(
    [detected.setup[0]?.run, detected.checks[0]?.run, detected.test?.run],
    [
      "bun install --frozen-lockfile --ignore-scripts",
      "node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false",
      "bun run test",
    ],
  );
});

it("syncs each SvelteKit workspace package offline after the install", () => {
  const detected = recipe({
    "package.json": json({ scripts: { check: "pnpm -r check" } }),
    "pnpm-lock.yaml": PNPM_LOCK,
    "pnpm-workspace.yaml": "packages:\n  - 'sites/*'\n  - '!sites/old'\n",
    "sites/docs/package.json": json({ devDependencies: { "@sveltejs/kit": "2" } }),
    "sites/old/package.json": json({ devDependencies: { "@sveltejs/kit": "1" } }),
    "fixtures/kit/package.json": json({ devDependencies: { "@sveltejs/kit": "2" } }),
  });
  assert.deepStrictEqual(detected.setup.slice(1), [
    {
      id: "svelte-kit sync sites/docs",
      run: "pnpm exec svelte-kit sync",
      cwd: "sites/docs",
      network: false,
    },
  ]);
});

it("runs node --test with the test script's flags, and a workspace's tests per package", () => {
  const node = recipe({
    "package.json": json({
      scripts: { test: "node --experimental-strip-types --test src/**/*.test.ts" },
    }),
    "package-lock.json": "{}",
  });
  assert.deepStrictEqual(node.test, {
    run: "node --experimental-strip-types --test",
    cwd: ".",
    target: "files",
    filterFlag: "--test-name-pattern",
  });
  const workspace = recipe({
    "package.json": json({ workspaces: ["apps/*"], scripts: { test: "npm test --workspaces" } }),
    "package-lock.json": "{}",
    "apps/web/package.json": json({ scripts: { test: "vitest run" } }),
  });
  assert.deepStrictEqual(workspace.test, {
    run: "npm test -w {dir} --",
    cwd: ".",
    target: "workspace",
    filterFlag: undefined,
  });
});

it("syncs a uv project and runs the type checkers, linters and pytest it locks", () => {
  const detected = recipe({
    "pyproject.toml": '[project]\nname = "x"\n[tool.uv.workspace]\nmembers = ["libs/*"]\n',
    "libs/a/pyproject.toml": '[project]\nname = "a"\n',
    "uv.lock": 'name = "pyright"\nname = "ruff"\nname = "pytest"\n',
    ".python-version": "3.12\n",
  });
  assert.deepStrictEqual(detected, {
    image: "python",
    keyFiles: [".python-version", "libs/a/pyproject.toml", "pyproject.toml", "uv.lock"],
    setup: [
      {
        id: "install",
        run: "uv sync --frozen --all-extras --all-groups --all-packages",
        cwd: ".",
        network: true,
      },
      { id: "pyright", run: ".venv/bin/pyright --version", cwd: ".", network: true },
    ],
    checks: [
      {
        id: "pyright",
        run: ".venv/bin/pyright --outputjson",
        cwd: ".",
        format: "pyright-json",
        scope: "repo",
      },
      {
        id: "ruff",
        run: ".venv/bin/ruff check --output-format json .",
        cwd: ".",
        format: "ruff-json",
        scope: "repo",
      },
    ],
    test: {
      run: ".venv/bin/python -m pytest -q -p no:cacheprovider",
      cwd: ".",
      target: "files",
      filterFlag: "-k",
    },
    notes: ["uv.lock"],
  });
});

it("installs requirements files into a venv and prefers basedpyright", () => {
  const detected = recipe({
    "package.json": json({ name: "web-client" }),
    "requirements.txt": "flask==3\n",
    "requirements-dev.txt": "basedpyright==1.40.2\npyright==1\n",
    "go.mod": "module x\n",
  });
  assert.deepStrictEqual(detected.image, "python");
  assert.deepStrictEqual(detected.setup, [
    {
      id: "install",
      run: "uv venv && uv pip install -r requirements-dev.txt -r requirements.txt",
      cwd: ".",
      network: true,
    },
  ]);
  assert.deepStrictEqual(
    detected.checks.map((check) => check.run),
    [".venv/bin/basedpyright --outputjson"],
  );
});

it("checks a cargo workspace offline with JSON messages and filters its tests by name", () => {
  const detected = recipe({
    "Cargo.toml": '[workspace]\nmembers = ["axum"]\n',
    "Cargo.lock": "",
    "axum/Cargo.toml": '[package]\nname = "axum"\n',
  });
  assert.deepStrictEqual(detected, {
    image: "rust",
    keyFiles: ["Cargo.lock", "Cargo.toml", "axum/Cargo.toml"],
    setup: [{ id: "fetch", run: "cargo fetch --locked", cwd: ".", network: true }],
    checks: [
      {
        id: "cargo-check",
        run: "cargo check --workspace --all-targets --offline --locked --message-format json",
        cwd: ".",
        format: "cargo-json",
        scope: "repo",
      },
    ],
    test: {
      run: "cargo test --workspace --offline --locked",
      cwd: ".",
      target: "filter",
      filterFlag: "",
    },
    notes: [],
  });
});

it("builds and vets a Go module and tests the packages of the given files", () => {
  const detected = recipe({ "go.mod": "module github.com/cli/cli/v2\n", "go.sum": "" });
  assert.deepStrictEqual(detected, {
    image: "go",
    keyFiles: ["go.mod", "go.sum"],
    setup: [{ id: "download", run: "go mod download", cwd: ".", network: true }],
    checks: [
      { id: "go-build", run: "go build ./...", cwd: ".", format: "text", scope: "repo" },
      { id: "go-vet", run: "go vet -json ./...", cwd: ".", format: "go-vet-json", scope: "repo" },
    ],
    test: { run: "go test -v", cwd: ".", target: "packages", filterFlag: "-run" },
    notes: [],
  });
});

it("lets .dorbs/check.json replace what detection found, and keys the environment on it", () => {
  const detected = recipe({
    "package.json": json({ scripts: { lint: "oxlint" } }),
    "package-lock.json": "{}",
    ".dorbs/check.json": json({
      setup: [{ id: "install", run: "npm ci --legacy-peer-deps --ignore-scripts", network: true }],
      checks: [{ id: "tsc", run: "npx tsc -b packages", format: "text" }],
      test: null,
      keyFiles: ["tools/setup.sh"],
    }),
    "tools/setup.sh": "",
  });
  assert.deepStrictEqual(detected.setup, [
    { id: "install", run: "npm ci --legacy-peer-deps --ignore-scripts", cwd: ".", network: true },
  ]);
  assert.deepStrictEqual(detected.checks, [
    { id: "tsc", run: "npx tsc -b packages", cwd: ".", format: "text", scope: "repo" },
  ]);
  assert.strictEqual(detected.test, undefined);
  assert.includeMembers(detected.keyFiles, [".dorbs/check.json", "tools/setup.sh", "package.json"]);
  assert.include(detected.notes, ".dorbs/check.json overrides setup, checks, test");
});

it("says why when it finds nothing it runs, or the override does not parse", () => {
  assert.deepStrictEqual(detect(view({ "README.md": "" })), {
    reason:
      "No package.json, pyproject.toml, requirements.txt, Cargo.toml or go.mod at the root, and no .dorbs/check.json.",
  });
  const broken = detect(
    view({ "go.mod": "", ".dorbs/check.json": json({ checks: [{ id: "x" }] }) }),
  );
  assert.isTrue("reason" in broken && broken.reason.startsWith(".dorbs/check.json: "));
});
