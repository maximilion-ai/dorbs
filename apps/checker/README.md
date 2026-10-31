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

- Node: the package manager from `packageManager`, else the lockfile (pnpm, yarn classic or berry, npm, bun); install with a frozen lockfile and no install scripts; `svelte-kit sync` for each SvelteKit workspace package, offline. Checks are the repo's own `typecheck` script (or `type-check`, `check:type`, `check:types`, `check-types`, `types:check`, `tsc`), else its `check` script, plus `lint`. Without a type-checking script, `tsc --noEmit -p tsconfig.json`, or `tsc -b` with project references, when TypeScript is installed. Without `lint`, eslint, biome or oxlint by their config. Tests: vitest, jest, `node --test` with the test script's flags, or one run per workspace package.
- Python: `uv sync --frozen` with a `uv.lock`, else a venv from `requirements*.txt`; basedpyright or pyright, mypy when configured, ruff; pytest.
- Rust: `cargo fetch`, then `cargo check --workspace --all-targets --offline`; `cargo test` with a name filter.
- Go: `go mod download`, then `go build ./...` and `go vet -json ./...`; `go test -v` on the files' packages.

`.dorbs/check.json` replaces the detected `image`, `setup`, `checks` or `test`, and adds `keyFiles`:

```json
{
  "setup": [
    { "id": "install", "run": "npm ci --legacy-peer-deps --ignore-scripts", "network": true }
  ],
  "checks": [
    { "id": "tsc", "run": "node_modules/.bin/tsc -b packages --pretty false", "format": "text" }
  ],
  "test": { "run": "node --test", "target": "files", "filterFlag": "--test-name-pattern" }
}
```

Formats: `text` (tsc, svelte-check, eslint's stylish, pyright's, prettier `--check`, GitHub annotations, `file:line:col:` lines, under pnpm `-r` and turbo prefixes too), `eslint-json`, `oxlint-json`, `pyright-json`, `ruff-json`, `cargo-json`, `go-vet-json`. A setup step has no network unless it says `"network": true`.

The recipe file and the package manager configs that can run code or point installs elsewhere (`.npmrc`, `.yarnrc*`, `.yarn/`, `bunfig.toml`, `.pnpmfile.cjs`, `.cargo/config*`, `setup.py`, `setup.cfg`, `rust-toolchain*`) come from the commit, since only those who can push should choose what setup runs with the network. The operator's registration may carry a `recipe`, which wins over the commit's.

## Environments

An environment is one repo at one recipe, key-file content and image; its key is their hash, so a change to a lockfile or manifest selects a new environment rather than being refused. Every thread on the repo shares it, one run at a time. States: absent, setting up, ready, busy, idle (container stopped), failed (with the step's output, answered again for `RETRY_SETUP_AFTER`, 10 minutes, before a new setup), evicted.

Setup checks the commit out of the repo's bare cache into `$DATA_DIR/envs/<key>/repo`, lays the change's key files over it and runs each step in a container of its own. A run lays the change over the tree in place, runs, kills whatever it left running, and takes the change off: new files go, and every tracked file that differs from the index, the run's own writes included, gets the commit's content back. Moving to another commit touches only the files that differ.

Past `DISK_BUDGET` (12 GiB) of environments, the least recently used are evicted before a setup and after it. A container idle for `IDLE_AFTER` (10 minutes) stops; its tree and installs stay. After a restart, environments come back idle and their containers are made anew.

## Containment

Each container runs as root without capabilities, with `no-new-privileges`, a read-only root, `/tmp` as a 1 GiB tmpfs and the environment's directory as the only writable mount, under `CONTAINER_MEMORY` (8g), `CONTAINER_CPUS` (4) and `CONTAINER_PIDS` (2048). Checks and tests have no network. Setup steps with network run on an internal Docker network whose only way out is `dorbs-egress`, a CONNECT proxy that reaches package registries on port 443 (`EGRESS_ALLOW` replaces its list; `SETUP_EGRESS=open` uses the default bridge instead). The service passes no secret into a container; the host fetches commits with the repo's read token. `CONTAINER_PREFIX` (`dorbs`) starts the names of its containers, network and label, so a second service on the host leaves the first's alone.

What it does not contain: a run can change untracked files in its environment, such as `node_modules`, for the runs after it on the same repo; and a setup step can send the repo's files to a registry host it allows.

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
