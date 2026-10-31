# Hillclimb harness

Measures how fast and how smoothly a dorbs thread gets a realistic coding task done. Frozen once baselined:
change the harness only between hillclimbs, and re-record the baseline when you do.

## Run

```sh
node scripts/hillclimb/run.ts [--suite sandbox|real] [--runs N] [--tasks id,id]
node scripts/hillclimb/run.ts --stack local [--harness pi|opencode] [--check-delay 0,2000] --runs N
node scripts/hillclimb/run.ts report [--batch id,id]
node --test scripts/hillclimb/metrics.test.ts
```

- `--stack cloud`, the default, drives the deployed Worker through `/tmp/dorbs-cloud.sock`, as T3 Code does.
- `--stack hc` drives the hillclimb stage `dorbs-hc` through `/tmp/dorbs-hc.sock`, the same way, so production stays
  untouched.
- `--stack local` starts the Worker under alchemy dev with a local mirror of the sandbox and the devbox
  checker behind a proxy. The proxy adds `--check-delay` ms to each checker call. Several delays alternate run
  by run on one stack, so they share its noise.
- Each run appends one line to `/tmp/dorbs-hillclimb/runs.jsonl` and writes its stamped frames to
  `/tmp/dorbs-hillclimb/frames/<runId>.json`. Each command ends with the summary table of its batch.
- Runs go round-robin over runs, tasks and configs. Every run prints its error count (failed tool calls and
  session errors) and its work (tool calls, writes, check and test calls).

## Replay

`replay.ts` measures the infrastructure alone, with no model tokens. Each task's plan in `plans/` is the tool calls of
one successful recorded run, in rounds of parallel calls, extracted by `plans.ts` from that run's frames. The hc
Worker, deployed with `MODEL_PROVIDER=replay`, plays a plan back from the prompt whatever the tools return, so runs
differ only in what the infrastructure does.

```sh
node scripts/hillclimb/plans.ts --batch <batch>          # rewrite plans/ from a recorded batch
node scripts/hillclimb/replay.ts --runs N --label <name>  # runs every plan N times against /tmp/dorbs-hc.sock
node scripts/hillclimb/replay.ts report --label a,b
```

The primary is the median over tasks of each task's median turn wall time; a run that diverged from the recording
(a mismatched outcome, a call that never ran, no end_turn) scores the 600 s ceiling and counts as an error. Each run also reports per-tool latency,
the overhead (turn wall minus wall covered by tool calls: the Durable Objects, the mux and history), failed calls,
calls whose outcome differs from the recording, and calls that never ran. Plans are fixed, so replay cannot credit a
change that saves the model a call; the final real-model run does.

### Replay baseline and decisions

Plans come from one recorded batch on the hc stage. The harness is frozen at N=1 per block, blocks of the full suite
alternating between the two sides, at least 3 per side (5 when close), with a 60 s settle after a deploy. A change
is kept when the primary drops and the per-task rank-sum over all runs gives z <= -2. Sensitivity: a 500 ms delay on
every checker request raised the primary 15.41 -> 16.83 s, z = 2.69, while other agents loaded devbox.

- Baseline, label base0: primary 13.27 s at N=5; 1100/1100 calls ran, 0 mismatches. Bootstrap p5-p95 at N=5 is
  10.5-13.7 s. Check p50 2.24 s; test p50 1.70 s, mostly waiting behind the check on the environment's queue.
- Kept: a check and a test of one workspace state run at once, 14.72 -> 9.73 s, z = -2.91, under devbox load 4-12.
  Shared GitHub App tokens in a Durable Object, 8.76 -> 8.22 s, z = -3.90.
- Reverted: a module-level token cache. Each session Durable Object runs in its own isolate, so it never hit.
- Final, interleaved against the baseline stack under devbox load ~3: 9.07 -> 8.51 s (-6%), z = -5.09, every task
  faster. The join saves more the busier the checker is. tsc in the sandbox's own typecheck now holds most of the
  time: 1.2 s of each check goes to @types/node.

## Tasks

`tasks.ts` holds two suites of ten tasks each, modelled on the thread study of Garten and fakts threads:
feature, bug fix, refactor, test, docs, review and research, easy and hard. Implementers verify with
`check` and `test`; reviewers and researchers change nothing.

- `sandbox` runs on maximilionai/dorbs-sandbox at f8fecad and works today.
- `real` runs on maximilionai/dorbs, maximilion-ai/garten and Fakts-org/fakts. It waits on the GitHub App
  reaching those repos and on adding them to the Worker's `REPOS`. The dorbs tasks pin feat/isolate-agents
  (4282f5c), because main holds only the README; they stay invalid until that branch lands on main.

Each task pins its base commit. clone_repo clones the default branch's head, so a run that clones another
commit is marked invalid and left out of the metric, not failed.

## Success predicate

A run succeeds when all of these hold:

- The turn ends with `end_turn` after a clone.
- For each tool in `verified`, the last call is green and starts after the turn's last write. A green test
  call passes at least `minTests` tests, and never zero.
- A follow-up probe turn reads each expected file with read_file and matches its patterns, and for committing
  tasks shows the run's branch checked out, a clean tree and a head beyond the base.
- Read-only tasks write nothing; reply patterns match the turn's reply.
- No `git push` or `gh pr create` call in either turn, and origin has no branch named after the run.

The probe's time is not counted.

## Metrics

From the task turn's frames: wall time to the prompt response, time to the first green check or test, tool
calls, failed tool calls (failed status, nonzero git or gh exit, or a refusal), check and test calls with
their latencies, model calls (a round starts with the first frame after every open tool call ended),
friction, infra errors, and the wall time split into model, check (check and test), clone and other tools.
The limiter is the largest share.

**Friction** counts tool results that show the agent misused or misunderstood a tool, one rule per call, the
first that matches. The rules are `FRICTION_RULES` in `metrics.ts`:

| Rule                | Tools                                  | Matches                                                   |
| ------------------- | -------------------------------------- | --------------------------------------------------------- |
| missing-path        | read_file, edit_file, list_files, grep | no such file, ENOENT, not a directory                     |
| bad-path            | any                                    | a path outside the repo, through a symlink or into `.git` |
| edit-mismatch       | edit_file                              | oldText must occur exactly once                           |
| bad-arguments       | any                                    | schema validation errors                                  |
| unknown-tool        | any                                    | a tool that does not exist                                |
| unsupported-command | git, gh                                | a subcommand, flag or global option the tool refuses      |
| shell-syntax        | git, gh                                | shell operators, backticks, `$(`                          |
| wrong-repo          | clone_repo                             | an unregistered repo, or a second repo                    |
| tool-order          | any                                    | check, test or git before clone_repo                      |
| unknown-check       | check                                  | a check id the repo lacks                                 |
| test-selection      | test                                   | files or a filter the repo's test command cannot take     |

A red check or test is iteration, not friction.

## Primary metric

**Median over tasks of the per-task median done time**, lower is better. Done time is the wall time of a
successful run and 600 s, the turn ceiling, for a failed one. Failing therefore never scores better than
succeeding slowly, and a task that fails in most runs dominates its median. Medians keep one slow model
response from swinging the result. Gates: the success count must not drop and failed tool calls must not
rise. Secondary: friction per run.

Stop predicate for the hillclimb: primary at least 40% below the baseline, and at least 10 iterations.

Use `--runs 5` for a keep-or-revert decision. Bootstrapped from 40 baseline runs, the primary's p5 to p95
band is 18.3 to 33.5 s at N=1, 19.0 to 28.9 s at N=3 and 19.0 to 26.5 s at N=5.

## Baseline

Deployed stack on 2026-10-31: HARNESS=pi, deepseek/deepseek-v4.1-flash on OpenRouter, devbox checker.
Sandbox suite, N=3, batch 4de65e.

| Task          | Difficulty | OK  | Done s p50 (range) | Check n / p50 s | Test n / p50 s | Model calls | Limiter |
| ------------- | ---------- | --- | ------------------ | --------------- | -------------- | ----------- | ------- |
| sb-survey     | easy       | 3/3 | 6.3 (5.5-19.4)     | 0 / -           | 0 / -          | 4           | model   |
| sb-review     | easy       | 3/3 | 9.5 (8.3-21.0)     | 1 / 1.3         | 1 / 0.3        | 6           | model   |
| sb-docs       | easy       | 3/3 | 11.3 (11.0-34.0)   | 0 / 1.6         | 0 / -          | 10          | model   |
| sb-sum        | easy       | 3/3 | 24.2 (19.4-56.8)   | 4 / 1.6         | 4 / 0.3        | 20          | model   |
| sb-greet-test | easy       | 3/3 | 18.7 (15.0-35.1)   | 3 / 1.5         | 3 / 1.5        | 16          | model   |
| sb-refactor   | hard       | 3/3 | 22.4 (15.7-25.2)   | 3 / 1.5         | 2 / 0.9        | 14          | model   |
| sb-chunk-bug  | hard       | 2/3 | 54.9 (49.7-600.0)  | 4 / 1.5         | 6 / 0.9        | 21          | check   |
| sb-money      | hard       | 3/3 | 17.8 (13.1-39.4)   | 2 / 1.6         | 2 / 0.4        | 13          | model   |
| sb-config     | hard       | 3/3 | 25.5 (22.5-96.1)   | 5 / 1.7         | 6 / 0.3        | 19          | model   |
| sb-events     | hard       | 3/3 | 30.2 (21.2-60.6)   | 3 / 1.6         | 3 / 0.3        | 18          | model   |

- Primary 20.5 s. Success 29/30; the failure is `initialize` timing out after 60 s while another client used
  the mux. Friction 8 calls in 30 runs: 6 unsupported-command, 2 missing-path. 9 failed tool calls in 584.
- Model rounds hold 70% of wall time, check and test 25%, clone 4%. A model round usually takes about 1 s,
  but some runs see 5 to 20 s rounds, which is most of the run-to-run spread.
- A session's first test call took 13.6 s at p50 (4 seen, up to 27 s); later test calls 0.34 s, check calls
  1.5 s. That cold first test is what makes sb-chunk-bug check-bound.

## Sensitivity

- **Easy against hard.** Over the 40 cloud runs, easy tasks finish at a 19.4 s median and hard ones at
  27.8 s; rank-sum AUC 0.76, p = 0.005. Read-only and docs tasks against implementers: AUC 0.81, p = 0.002.
- **A slower checker.** `--stack local --check-delay 0,2000`, sb-sum, sb-greet-test, sb-config and
  sb-events, N=5 each, alternating (batch f03f35). The primary rises from 28.8 to 40.7 s (+41%), and every
  task's median rises. Check calls go from 1.5 to 3.6 s, so the delay reached them. Rank-sum on done time
  normalised per task: AUC 0.78, p = 0.002. Success stays 20/20 on both.
