---
name: dorbs-checker-speed
description: Make the dorbs checker's check and test fast on a repo, within its CPU and memory budget, without losing a diagnostic. Use after registering a repo on the checker, when check or test is slow or queues, or when sessions on one repo wait for each other.
---

# Make check and test fast on a repo

Agents call `check` and `test` many times per session, and many sessions share one checker. Every second a run spends is paid once per call. This skill is the procedure: measure, find what limits a run, change one lever, measure again. Register the repo first with the `dorbs-checker` skill. Reference: `crates/dorbs-check/README.md`.

Three rules:

- **Correct before fast.** A fast check that drops a type error is worse than a slow one. Probe errors before and after every change.
- **Measure, don't guess.** The bench replays real changes; a lever stays only when warm runs show the gain beyond their spread.
- **Data before code, general before specific.** A lever that helps a class of repos goes in the adapter TOML with a `when`. One repo's quirk goes in its registration's `recipe`. Change Rust only when no data can say it.

## 1. Give the repo a job set

A set is real work on the repo: `scripts/checker-bench/<name>.json`.

```json
{
  "repo": "owner/name",
  "url": "https://github.com/owner/name.git",
  "public": true,
  "base": "<commit every request names>",
  "jobs": [
    { "kind": "check", "head": "<sha>", "from": "<its parent>" },
    { "kind": "test", "ref": "refs/pull/12/head", "head": "<pinned sha>" }
  ]
}
```

- Take 10 to 20 merged commits or PRs after `base`, about 60% checks and 40% tests, as agents call them. A job's change is what `head` changed from `from` (the base when absent), laid over the base. A test job runs the test files its change touched, so pick commits that touch tests.
- Skip commits that change the lockfile or manifests: they need another environment.
- Pin every SHA, so each run does the same work.

## 2. Measure

On the checker host (devbox), from a copy of this branch, with a static build:

```sh
cargo build --release --target x86_64-unknown-linux-musl -p dorbs-check
SLICE=1 REPLICAS=1 RUN_SLOTS=1 CONTAINER_CPUS=4 CONTAINER_MEMORY=14g SETUP_MEMORY=14g \
  node scripts/checker-bench.ts up --binary target/x86_64-unknown-linux-musl/release/dorbs-check
node scripts/checker-bench.ts run --set <name> --label cold     # includes setup
node scripts/checker-bench.ts run --set <name> --label warm1
node scripts/checker-bench.ts run --set <name> --label warm2
node scripts/checker-bench.ts down
```

The bench is its own instance (port 8791, `~/dorbs-checker-bench`); never stop or reconfigure the production unit `dorbs-checker`. `SLICE=1` runs the service and every container in one systemd slice that holds the whole budget (4 CPUs, 16 GiB). Each run prints a table and writes a JSON result.

Read it in this order:

1. **Answered and correct.** Every job answered; no `SetupFailed`; tests report counts, not `?`; no OOM kills.
2. **Makespan and jobs/min** of the warm runs, and how far apart the two are. That spread is the noise floor.
3. **Per check and test: run time.** `queue` is waiting for others; `run` is the work. Shrink `run`.
4. **CPU % of the budget and throttled seconds.** Low CPU with long runs means a run waits on something. High CPU with heavy throttling means the work is CPU-bound.

Then probe correctness through the service: one change with a type error and a lint error must come back as diagnostics at the right `path:line`.

```sh
CHECK_URL=http://127.0.0.1:8791 CHECK_TOKEN=$(cat ~/dorbs-checker-bench/check-token) \
  node scripts/checker.ts check owner/name <base> --put src/a.ts=/tmp/a-with-errors.ts --json
```

## 3. Find what limits a run, and pull its lever

| What you see                                                               | Cause                                                                                                                                                                                 | Lever                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A command takes seconds but little CPU, the same seconds on every call     | A tool reaches for the network in the networkless container and waits for a timeout (Vite+ fetches its package manager: 5 s per `vp` call)                                            | Find the request in the tool's debug log (`VP_LOG=debug`, `RUST_LOG=debug`, `--verbose`). Do the download in an `online` setup step, so the tool finds it in `/env/home` (node.toml's `vite-plus package manager` step)                                                   |
| Lint takes the same 10 s for a one-line change                             | The repo's lint script scans the whole repo                                                                                                                                           | `[[narrow]]` in the adapter runs a file-taking linter on `{changed}` (node.toml: `vp lint` and `oxlint`). For one repo, its recipe's lint `run` with `{changed}`. Linters that need the whole repo (import cycles, unused exports) lose those rules: say so in the commit |
| One session's check is slow after another session changed a shared package | A task runner's cache keeps one entry per task, so sessions evict each other (Vite+, turbo, nx)                                                                                       | `[[warm]]` in the adapter: setup runs the checks once and every run gets the cache back as that left them. Prove it first: time change Y after change X with and without restoring the cache                                                                              |
| A check fails with 0 diagnostics, or a test reports `? passed`             | Output the patterns do not read: colored or graphical reporters, paths relative to a package a task-runner header names, summaries in raw output                                      | Ask the tool for a format the adapter reads (`--format github`, `--reporter=junit`), add errorformat patterns (`%D` for a header that names a directory), and commit the real output as a fixture in `crates/dorbs-check/tests/fixtures`                                  |
| `Killed (exit 137)` in a check's output                                    | The container ran out of memory                                                                                                                                                       | More memory per container, or fewer parallel tasks in the repo's command                                                                                                                                                                                                  |
| A test answers `failed` with 0 failed tests, or flakes only on the checker | The runner itself broke or timed out, under the container's few CPUs: a test pool that crashes past its first file per worker, tests that share one double, timeouts set for a laptop | Reproduce locally with as few workers as the container has (`--maxWorkers 2`), read the runner's unhandled errors, and fix the repo's test setup. Prove it through the service: before and after, several runs                                                            |
| CPU at the budget, heavy throttling                                        | CPU-bound work                                                                                                                                                                        | Budget shape, below. Then less work per run: the levers above                                                                                                                                                                                                             |

Change one lever, rerun two warm runs, and keep it only when the gain clears the spread. A lever that changes the recipe or image changes the environment's key, so the next run sets up again: run cold first.

## 4. Shape the budget

The checker gets a fixed budget (now 4 CPUs and 16 GiB on devbox). Measured on t3code-eval, a CPU-bound monorepo:

| Config                                               | Jobs/min   |
| ---------------------------------------------------- | ---------- |
| 1 replica, container capped at 3.5 CPUs, service 0.5 | 4.0        |
| 2 replicas at 1.75 CPUs each                         | 3.9 to 4.2 |
| 1 replica, service and container in one 4-CPU slice  | 5.0        |
| 2 replicas in the slice                              | 4.9        |
| 3 replicas in the slice                              | 4.4 to 4.7 |

- Put the service and its containers in one slice (`CONTAINER_CGROUP_PARENT`), so the budget holds as a whole and no share sits idle.
- More replicas only split the same CPUs and each re-does work the other's cache holds. Add one only when runs wait on something other than CPU.
- Memory: a T3 Code check peaks near 6 GiB per replica. Size per replica from the bench's peak, with a quarter to spare.

## 5. Ship it

- `pnpm rust` passes; a change to `environments.rs` also passes `cargo test --test live -- --ignored` on the host.
- The commit names each lever and its numbers: makespan and jobs/min before and after, warm runs, the set.
- Leave the bench stopped (`down`); `down --purge` also deletes its environments and slice.

## Pitfalls

- The first run after a recipe or image change includes setup; compare warm runs only.
- The service answers a repeated identical check from memory (`REMEMBER_CHECKS`); the bench sets it to 0, keep it so.
- A `[[warm]]` or `[[narrow]]` table in an adapter TOML takes every key after it: put tables at the end of the file.
- To compare against another version, build it in its own `CARGO_TARGET_DIR`: a shared one can hand back the other build's binary. Check with `strings` that the binary holds the adapter you expect.
- The `regex` crate has no lookahead: exclude with a rule's `unless`, not `(?!`.
- Per-container CPU caps that add up to the budget leave CPU idle whenever one container waits; the slice does not.
