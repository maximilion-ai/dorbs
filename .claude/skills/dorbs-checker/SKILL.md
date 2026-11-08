---
name: dorbs-checker
description: Add a repo or a new language toolchain to the dorbs checker (crates/dorbs-check), the service behind the agent's check and test tools. Use when registering a repo for dorbs threads, when check or test gives wrong or no results on a repo, or when adding an adapter for an ecosystem such as Elixir, Java or PHP.
---

# Add repos and toolchains to the checker

The checker gives every agent the same two tools, `check` and `test`, on any repo. It runs the repo's own commands in a warm rootless Docker environment per repo and lockfile. Reference: `crates/dorbs-check/README.md` (recipes, adapter fields, formats, containment). This skill is the procedure.

Two rules decide almost everything:

- **Run the repo's own commands.** A repo's `typecheck`, `lint`, `check` and `test` scripts (package.json, justfile, mise, Makefile) win over anything an adapter guesses. Agents then see what humans and CI see.
- **Data, not code.** A repo gets a recipe, an ecosystem gets one adapter TOML. Change Rust only when a whole class of repos cannot be expressed.

## Add a repo

1. **Access.** Install the dorbs GitHub App on the repo (selected repositories). A public repo can skip this with `"public": true`.
2. **See what the checker would run.** In a local checkout with dependencies installed:

   ```sh
   cargo run -q -p dorbs-check -- recipe --dir <checkout>
   cargo run -q -p dorbs-check -- check --dir <checkout>
   cargo run -q -p dorbs-check -- test --dir <checkout> <one test file>
   ```

   `recipe` prints the resolved setup, checks and test command. Check each against what the repo's CI runs.

3. **Register it on the checker host.** Add `{ "id": "owner/name", "url": "https://github.com/owner/name.git" }` to the host's `REPOS_FILE`, then `systemctl --user restart dorbs-checker`.
4. **Register it with the Worker.** Add the same id and url to the Worker's `REPOS` and redeploy (see the `dorbs-setup` skill).
5. **Prove it on the service, not the CLI.** Run one check and one test through the HTTP API or a dorbs thread. A first request sets the environment up (seconds to minutes); the second shows the warm time. Then add one deliberate type error and confirm `check` reports it at the right `path:line`. A clean result alone proves nothing.

#6. **Make it fast.** Follow the `dorbs-checker-speed` skill: a job set of the repo's real changes, the bench, and the levers that cut a run without losing a diagnostic.

## When detection gets it wrong

Fix it in this order and stop at the first that works:

1. **The repo lacks a named command.** Add a `typecheck` or `test` script to the repo itself. Every tool benefits, not only dorbs.
2. **The repo needs setup the adapter cannot guess** (a build before typecheck, `--legacy-peer-deps`, a broken lockfile). Give the registration a `recipe`, which only the operator controls. Split every install into an `online` download step, which sees only manifests and lockfiles, and an `offline` step that installs from the cache with the full tree and no network:

   ```json
   {
     "id": "acme/app",
     "url": "https://github.com/acme/app.git",
     "recipe": {
       "image": "node",
       "setup": [
         { "id": "download", "run": "pnpm fetch", "phase": "online" },
         { "id": "install", "run": "pnpm install --offline --frozen-lockfile --ignore-scripts" },
         { "id": "build", "run": "pnpm build" }
       ]
     }
   }
   ```

3. **The repo's owners want to carry it.** Commit the same recipe as `.dorbs/check.json`. It cannot declare `online-with-source` steps and cannot widen what online steps see.

Never grant `online-with-source` to make a repo work without reading the containment section of the README first. That phase gives setup code the source and the network at once.

## Add a toolchain

A new ecosystem is one file, `crates/dorbs-check/adapters/<name>.toml`. Start from the closest existing adapter (`ruby.toml` is the smallest complete one). Its parts:

| Part                   | Fill it with                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `priority`, `detect`   | Globs that identify the ecosystem, such as `mix.exs`                                                                                |
| `image`                | A Dockerfile with the language and the tools checks need. Its hash tags the image                                                   |
| `egress`               | The package registry hosts online steps may reach. Nothing else                                                                     |
| `env`                  | Caches under `/env/home`, so they survive between runs of one environment                                                           |
| `commit_only`          | Package manager files that can run code or redirect downloads                                                                       |
| `[[setup]]`            | An `online` download step and an `offline` install step, both with `key` globs of the manifests and lockfiles                       |
| `[[checks]]`           | Ids `typecheck` and `lint`; each with `run` and, if the tool can emit it, `format = "sarif"`                                        |
| `[output] errorformat` | Vim-style patterns for tools without SARIF; `%n` captures the code                                                                  |
| `[[tests]]`            | `run` with `{files}` and `{filter}`, `filter_flag`, and `format = "junit"` or `"tap"` with `{report}` when the runner can write one |

Steps:

1. **Write the adapter and load it without rebuilding**: `ADAPTERS_DIR=<dir with your toml> cargo run -q -p dorbs-check -- recipe --dir <checkout>`.
2. **Prove the parser on real output.** Capture the tool's output once with a known error, then `cargo run -q -p dorbs-check -- parse --adapter <name> < out.txt`. Every error line must come back as a diagnostic with file, line and code. Lines that fall through return as raw output, which is safe but less useful.
3. **Prefer a structured format.** SARIF for checks and JUnit or TAP for tests give exact counts; `raw` tests report pass or fail only. Agents use the counts.
4. **Commit a fixture** of that output and a parser test in `crates/dorbs-check/tests/`, so a format change shows up in `pnpm rust`.
5. **Run it on a real repo through the service.** Build the static binary and deploy as the README's "Run on the host" says, register a small public repo of that ecosystem, and repeat the probe from "Add a repo" step 5 for both `check` and `test`.
6. **Compare with the repo's own command.** Add a case to `scripts/checker-accept.ts` (repo, commit, the repo's own command) and run `node scripts/checker-accept.ts owner/name` on the host. The service's error set must equal the repo's own.

## Done means

- `pnpm check` passes; it runs `pnpm rust` (fmt, clippy, cargo test).
- The probe error comes back at the right place through the service, and `test` reports real counts.
- For a toolchain: `checker-accept.ts` shows the same errors as the repo's own command, and the escape test still passes on the host: `cargo test --test live -- --ignored`.
