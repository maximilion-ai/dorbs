# checker

One HTTP service that runs a repo's own static checks and tests on an agent's changes, in a warm environment per repo: rootless Docker on a Linux host, one container per environment. It replaces `apps/typecheck`. Request and response shapes live in `@dorbs/protocol/checker`.

## API

Every route requires `Authorization: Bearer $CHECK_TOKEN` and answers 401 otherwise. A body over 16 MiB gets 413.

- `POST /check` takes a repo, a commit, the session's change (whole files and deleted paths) and optionally `only`, the check ids to run. It answers a `CheckResult`: per check its command, status, exit code, LSP diagnostics with repo-relative paths, and the output lines no parser read; plus the environment key, `complete` and the time spent in setup and in laying the change over the tree.
- `POST /test` takes the same and `files` (test files, or pytest ids) or `filter` (a test name pattern). It answers a `TestResult`: the command, the status, pass, fail and skip counts from the runner's summary, and the end of the output.
- Either may answer `SetupFailed` with the failed step's output, or `Rejected`: `UnknownRepo`, `UnknownCommit`, `NoRecipe`, `UnknownChecks`, `NoTestCommand` or `UnsafePath` (a write through a symbolic link of the tree). A failed fetch answers 502; a missing image answers 503.
- `GET /environments` lists the environments, their state and bytes on disk.

## Recipes

The service reads the commit's manifests, lockfiles and configs, lays the change over them and detects a recipe: an image, setup steps, checks with a diagnostic format and scope, and a test command.

Each setup step has a phase. `online` steps run first, with the network, in a tree of the manifests, lockfiles and package manager files alone (`package.json` and `pyproject.toml` at any depth, lockfiles, `pnpm-workspace.yaml`, `.npmrc`, `requirements*.txt`, `Cargo.toml`, `go.mod` and the like, and an empty file for each Rust source, whose paths cargo reads), so nothing they run can read the source; they fill the package managers' caches in the environment's home. Then that tree goes, the commit is checked out, and `offline` steps install from the caches, build and run whatever else the recipe asks, without network. `online-with-source` steps get the network and the full tree, before the offline steps; only the operator's registration may declare one.

- Node: the package manager from `packageManager`, else the lockfile (pnpm, yarn classic or berry, npm, bun); online, `pnpm fetch` or an install into the manager's cache; offline, the install with a frozen lockfile and no install scripts, then `svelte-kit sync` for each SvelteKit workspace package. Checks are the repo's own `typecheck` script (or `type-check`, `check:type`, `check:types`, `check-types`, `types:check`, `tsc`), else its `check` script, plus `lint`. Without a type-checking script, `tsc --noEmit -p tsconfig.json`, or `tsc -b` with project references, when TypeScript is installed. Without `lint`, eslint, biome or oxlint by their config. Tests: vitest, jest, `node --test` with the test script's flags, or one run per workspace package.
- Python: with a `pyproject.toml` or `uv.lock`, online `uv sync --no-install-local` for the dependencies and a full `uv sync` that fails but leaves the project's build backends cached, offline `uv sync --offline`; else a venv from `requirements*.txt`, the same way. basedpyright or pyright, whose wheel downloads pyright online, mypy when configured, ruff; pytest.
- Rust: `cargo fetch` online, then `cargo check --workspace --all-targets --offline`; `cargo test` with a name filter.
- Go: `go mod download` online, then `go build ./...` and `go vet -json ./...`; `go test -v` on the files' packages.

`.dorbs/check.json` replaces the detected `image`, `setup`, `checks` or `test`, and adds `keyFiles`:

```json
{
  "setup": [
    { "id": "download", "run": "npm ci --legacy-peer-deps --ignore-scripts", "phase": "online" },
    { "id": "install", "run": "npm ci --offline --legacy-peer-deps --ignore-scripts" }
  ],
  "checks": [
    { "id": "tsc", "run": "node_modules/.bin/tsc -b packages --pretty false", "format": "text" }
  ],
  "test": { "run": "node --test", "target": "files", "filterFlag": "--test-name-pattern" }
}
```

Formats: `text` (tsc, svelte-check, eslint's stylish, pyright's, prettier `--check`, GitHub annotations, `file:line:col:` lines, under pnpm `-r` and turbo prefixes too), `eslint-json`, `oxlint-json`, `pyright-json`, `ruff-json`, `cargo-json`, `go-vet-json`. A setup step's `phase` is `offline` unless it says otherwise; a commit's file may not say `online-with-source`.

The recipe file and the package manager configs that can run code or point installs elsewhere (`.npmrc`, `.yarnrc*`, `.yarn/`, `bunfig.toml`, `.pnpmfile.cjs`, `.cargo/config*`, `setup.py`, `setup.cfg`, `rust-toolchain*`) come from the commit, not the change. The operator's registration may carry a `recipe`, which wins over the commit's.

## Environments

An environment is one repo at one recipe, key-file content and image; its key is their hash, so a change to a lockfile or manifest selects a new environment rather than being refused. Every thread on the repo shares it, one run at a time. States: absent, setting up, ready, busy, idle (container stopped), failed (with the step's output, answered again for `RETRY_SETUP_AFTER`, 10 minutes, before a new setup), evicted.

Setup writes the online tree into `$DATA_DIR/envs/<key>/repo` and runs the online steps, then removes it, checks the commit out of the repo's bare cache in its place, lays the change's key files over it and runs the other steps, each step in a container of its own. A run lays the change over the tree in place, runs, kills whatever it left running, and takes the change off: new files go, and every tracked file that differs from the index, the run's own writes included, gets the commit's content back. Moving to another commit touches only the files that differ.

Past `DISK_BUDGET` (12 GiB) of environments, the least recently used are evicted before a setup and after it. A container idle for `IDLE_AFTER` (10 minutes) stops; its tree and installs stay. After a restart, environments come back idle and their containers are made anew.

## Containment

Each container runs as root without capabilities, with `no-new-privileges`, a read-only root, `/tmp` as a 1 GiB tmpfs and the environment's directory as the only writable mount, under `CONTAINER_MEMORY` (8g), `CONTAINER_CPUS` (4) and `CONTAINER_PIDS` (2048). Checks, tests and offline setup steps have no network. Online setup steps run on an internal Docker network whose only way out is `dorbs-egress`, a CONNECT proxy that reaches package registries on port 443 (`EGRESS_ALLOW` replaces its list; `SETUP_EGRESS=open` uses the default bridge instead), and see no source. The service passes no secret into a container; the host fetches commits with the repo's read token. `CONTAINER_PREFIX` (`dorbs`) starts the names of its containers, network and label, so a second service on the host leaves the first's alone.

What it does not contain: a run can change untracked files in its environment, such as `node_modules`, for the runs after it on the same repo; what a change writes into its manifests and lockfiles reaches the online steps, so it can leave in a download's URL to an allowed host; and an `online-with-source` step runs with whatever the online steps left in the home.

## Run on the host

```sh
apps/checker/images/build.sh          # dorbs-checker/{node,python,rust,go}:1; the service also builds a missing one
cp apps/checker/deploy/dorbs-checker.service ~/.config/systemd/user/
systemctl --user enable --now dorbs-checker
```

`~/.config/dorbs/checker.env` sets `DATA_DIR`, `REPOS_FILE`, `HOST` (default `127.0.0.1`), `PORT` (8080), `DOCKER_HOST` and `GITHUB_APP_ID`; `deploy/start.sh` reads `CHECK_TOKEN` from `~/.config/dorbs/check-token` and the App key from `~/.config/dorbs/github-app.pkcs8.pem`. `REPOS_FILE` registers repos as `apps/typecheck` does, with `public: true` for a repo fetched without a token and an optional `recipe`.

## Test

```sh
pnpm --filter @dorbs/checker test                      # anywhere: detection, parsers, trees, environments with a fake Docker
node scripts/checker-accept.ts [owner/name ...]        # on the host: the spike repos against their own commands
```
