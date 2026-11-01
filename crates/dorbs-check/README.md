# dorbs-check

One `check` and `test` interface for any repo. The same core runs as an HTTP service, in warm rootless Docker environments, and as a command in a local checkout. Request and response shapes live in `@dorbs/protocol/checker`; `packages/protocol/fixtures/checker` holds both sides to them.

## Command line

```sh
dorbs-check check [--dir DIR] [--only ID]... [--json]     # the repo's checks, as diagnostics
dorbs-check test [--dir DIR] [--filter PATTERN] [--json] [FILE]...
dorbs-check recipe [--dir DIR]                            # the recipe the checkout resolves to
dorbs-check parse --adapter NAME [--format F] [--root DIR] < output
dorbs-check serve                                         # the HTTP service
```

`check` and `test` run in the checkout, with what its owner installed, and exit 0 when everything passed, 1 when something failed, 2 when they could not run. `--json` prints the protocol's `CheckResult` or `TestResult`.

## API

Every route requires `Authorization: Bearer $CHECK_TOKEN` and answers 401 otherwise. A body over 16 MiB gets 413, one that does not parse 400.

- `POST /check` takes a repo, a commit, the session's change (whole files and deleted paths) and optionally `only`, the check ids to run. It answers a `CheckResult`.
- `POST /test` takes the same and `files` (test files, or pytest ids) or `filter` (a test name pattern). It answers a `TestResult`.
- Either may answer `SetupFailed` with the failed step's output, or `Rejected`: `UnknownRepo`, `UnknownCommit`, `NoRecipe`, `UnknownChecks`, `NoTestCommand` or `UnsafePath`. A failed fetch answers 502; an image that does not build, 503.
- `GET /environments` lists the environments, their state and bytes on disk.

## Recipes

A recipe says how to set a repo up, check it and test it. Four layers make it; for setup, checks and test, the first that says something wins:

1. The operator's registration: the `recipe` of the repo in `REPOS_FILE`.
2. The commit's `.dorbs/check.json`. It may not give a step the phase `online-with-source`, and an online step of its may see only the adapter's online files.
3. The repo's own commands: package.json scripts, justfile recipes, mise tasks and Makefile targets named `typecheck` (or `type-check`, `check:type`, `check:types`, `check-types`, `types:check`, `tsc`), `lint`, `check` and `test`. A `check` command is left out when there is a `typecheck` one. An adapter says which sources its image runs; a local checkout runs them all.
4. The adapter's defaults, which fill only the parts the repo leaves: a default `typecheck` runs when the repo has none and no `check` command whose body matches its `covered_by`. A test marked `runner` runs the runner the repo's test script runs, with files and a filter, so it stands in for that script.

A recipe file:

```json
{
  "image": "node",
  "setup": [
    { "id": "download", "run": "npm ci --legacy-peer-deps --ignore-scripts", "phase": "online" },
    { "id": "install", "run": "npm ci --offline --legacy-peer-deps --ignore-scripts" }
  ],
  "checks": [{ "id": "typecheck", "run": "node_modules/.bin/tsc -b packages --pretty false" }],
  "test": {
    "run": "node --test {files} {filter}",
    "filterFlag": "--test-name-pattern",
    "format": "raw"
  }
}
```

`image` names the adapter whose image runs the repo. A step's `phase` is `offline` unless it says otherwise; its `key` names the files it depends on, the adapter's for its phase when absent. A check's `format` is `errorformat` with the adapter's patterns unless it says otherwise. A test's `run` names `{files}`, `{dirs}` (their directories), `{filter}` (after `filterFlag`, empty when the filter is positional) and `{report}`; `perPackage` runs it once per workspace package of the files, `{dir}` naming it. `"test": null` says the repo has none.

## Adapters

An adapter is one TOML file per ecosystem in `adapters/`, which the binary embeds; `ADAPTERS_DIR` adds files or replaces them by name. A new ecosystem is one file. The fields:

- `priority` and `detect`: among the adapters a path of the repo matches, the highest priority whose recipe has a check wins.
- `image`: the Dockerfile; its hash tags the image, so a change rebuilds it. `env`: its containers' environment, caches under `/env/home`. `egress`: the hosts its online steps download from.
- `ignore`: paths none of its globs see. `commit_only`: package manager files that can run code or redirect downloads, which setup takes from the commit, never from the change.
- `commands`: how the image runs a repo command, by source, `{name}` naming it.
- `output.errorformat`: the patterns a check without its own format is read with. `output.prefixes` and `output.names`: how a `pnpm -r` or turbo prefix names the package a line comes from. `workspace`: which directories are workspace packages.
- `[[let.NAME]]`: options for a value the templates name as `{NAME.field}`; the first whose `when` holds wins.
- `[[setup]]`, `[[checks]]`, `[[tests]]`: the defaults, each with an optional `when`. A setup step's `each` runs it in each workspace package whose files match.

A `when` holds when each field it gives does: `exists` (a path matches one of these globs), `absent` (none matches), `contains` (a matching file's content matches a regex, whose named groups the templates can use), `vars` (template values equal these) and `any` (one of these conditions holds).

## Formats

A check or test names one of five formats. A run whose command names `{report}` is read from the file it writes there; its stdout and stderr stay output. Whatever no format reads comes back as output lines.

- `errorformat`: vim's patterns, as `:help errorformat` and reviewdog have them, with `%E %W %I %N %A %C %Z` for multi-line messages and `%P %Q` for a file's lines. `%n` reads a code such as TS2322 or no-unused-vars.
- `sarif`: SARIF 2.1 results, as ruff writes them.
- `junit`, `tap`: test counts from a runner's report.
- `raw`: nothing to read.

## Environments

An environment is one repo at one recipe, setup key-file content and image; its key is their hash, so a change to a lockfile or manifest selects a new environment. Every request on the repo shares it, one run at a time in the order they came. `REPLICAS` (1) copies of it, each with its own tree and container, let that many runs on one repo go at once: a request takes a free copy, sets up a new one while there are fewer, or queues on the copy with the fewest requests; `RUN_SLOTS` (4) caps the runs across all environments. States: absent, setting up, ready, busy, idle (container stopped), failed (its output answered again for `RETRY_SETUP_AFTER`, 10 minutes), evicted.

Setup checks the online steps' key files out into `$DATA_DIR/envs/<key>/repo`, with an empty file for each stub, and runs the online steps; then that tree goes, the commit is checked out, the change's key files are laid over it, and the other steps run, each step in a container of its own. A run lays the change over the tree in place, runs, kills whatever it left running, and takes the change off: new files go, and every tracked file that differs from the index gets the commit's content back.

Past `DISK_BUDGET` (12 GiB) of environments, the least recently used are evicted. A container idle for `IDLE_AFTER` (10 minutes) stops. After a restart, environments come back idle and their containers are made anew.

## Containment

Each container runs without capabilities, with `no-new-privileges`, a read-only root, `/tmp` as a 1 GiB tmpfs and the environment's directory as its only writable mount, under `CONTAINER_MEMORY` (8g), `CONTAINER_CPUS` (4) and `CONTAINER_PIDS` (2048). `CONTAINER_CGROUP_PARENT` puts every container under one cgroup, such as a systemd slice that holds the service too, so a single CPU and memory budget covers them all. Checks, tests and offline setup steps have no network. Online setup steps run on an internal network whose only way out is `<prefix>-egress`, a CONNECT proxy to the adapters' `egress` hosts on port 443 (`EGRESS_ALLOW` replaces the list; `SETUP_EGRESS=open` uses the default bridge), and see no source. The proxy is this binary in a scratch image. The host fetches commits with the repo's read token: `tokenEnv`'s, or one the GitHub App mints, read-only and for that repo alone; no secret reaches a container. A run's report is read back from inside its container, and a tree whose root a run swapped for a link is neither restored nor written to: its environment is evicted. `CONTAINER_PREFIX` (`dorbs`) starts the names of the service's containers, network and label.

What it does not contain: a run can change untracked files in its environment, such as `node_modules`, for the runs after it; what a change writes into its manifests and lockfiles reaches the online steps, so it can leave in a download's URL to an allowed host; and an `online-with-source` step runs with whatever the online steps left in the home.

## Run on the host

```sh
cargo build --release --target x86_64-unknown-linux-musl   # static, so the egress image can run it
cp target/x86_64-unknown-linux-musl/release/dorbs-check crates/dorbs-check/deploy/start.sh ~/dorbs-checker/bin/
cp crates/dorbs-check/deploy/dorbs-checker.service ~/.config/systemd/user/
systemctl --user enable --now dorbs-checker
```

`~/.config/dorbs/checker.env` sets `DATA_DIR`, `REPOS_FILE`, `HOST` (127.0.0.1), `PORT` (8080), `DOCKER_HOST` and `GITHUB_APP_ID`; `start.sh` reads `CHECK_TOKEN` from `~/.config/dorbs/check-token` and the App key from `~/.config/dorbs/github-app.pkcs8.pem`. `REPOS_FILE` lists `{ "id", "url", "tokenEnv"?, "public"?, "recipe"? }`.

## Test

```sh
pnpm rust                                                   # anywhere: fmt, clippy, the parsers, recipes, trees, the CLI
cargo test --test live -- --ignored                         # on the host: the setup and tree escapes
node scripts/checker-accept.ts [owner/name ...]             # on the host: the spike repos against their own commands
node scripts/checker-bench.ts up --binary PATH | run | down   # on the host: 20 eval jobs on a bench instance, port 8791
```
