# Build plan: isolate-backed T3 threads

T3 Code launches `/usr/bin/nc -U <socket>` as a Local ACP command. `acp-mux` relays each socket connection to the agent Worker over one WebSocket. A Durable Object is the ACP agent. Type checks go to one shared service.

Research behind every choice: `docs/research/t3-conventions.md`, `docs/research/acp-contract.md`, `docs/research/platform-apis.md`. Decisions: `docs/decisions.tsv`.

## Data shapes

**`packages/protocol`** (Effect Schema, shared by all apps)

- `JsonRpcFrame`: union of `Request {id, method, params}`, `Notification {method, params}`, `Response {id, result} | {id, error}`. Parsed once at each wire boundary.
- ACP v1 subset, vendored from T3's `packages/effect-acp` v1 schemas (MIT, commit `125b619`): `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/update`, `session/request_permission`.
- Type-check API with branded `Sha256` and `RelativePath`:
  - `CheckRequest {lockfile: Sha256, files: ReadonlyArray<{path: RelativePath, sha256: Sha256}>}`
  - `CheckResponse = MissingBlobs {sha256s} | CheckResult {diagnostics, durationMs}`
  - `Diagnostic {tool: "tsrs" | "oxlint", path, line, column, code, message, severity}`

**`apps/agent-worker`** (Worker + one Durable Object per ACP connection)

- The Worker routes `GET /acp?connection=<id>` to the `AcpConnection` DO named `<id>`.
- A DO holds a session state machine: `Idle | Prompting {requestId, abort} | Cancelling {requestId}`. `session/cancel` always resolves the open prompt with `stopReason: "cancelled"`.
- The Computer workspace is the DO's files. Pi runs the agent loop. Tools are workspace read/write/edit/list/grep, isolate shell, git commit/push, and `typecheck`.
- Pi events map to `session/update` through one pure table: text to `agent_message_chunk`, tool start to `tool_call`, a file write to `tool_call_update` with `diff` content under the T3 cwd.

**`apps/acp-mux`** (Node daemon, a dumb pipe)

- One unix socket server. Each accepted connection gets a random connection id and one WebSocket to `AGENT_URL/acp?connection=<id>` with a bearer token. Lines flow both ways unchanged. Either side closing closes both.

**`apps/typecheck`** (Node HTTP service)

- `POST /check` takes a `CheckRequest`. Unknown blobs return `MissingBlobs`. `PUT /blobs/:sha256` stores one blob.
- Dependencies install once per lockfile hash (`pnpm install --frozen-lockfile --ignore-scripts`) and every check on that lockfile shares them.
- Each check materializes the files, runs native `tsrs` and `oxlint`, and returns diagnostics. A semaphore sized to the CPU count bounds concurrency.

## Units, in order

1. **Scaffold.** Workspace, catalog, strict tsconfig, oxlint, Biome (format only), tsrs, Vitest, knip, `pnpm check`, and `scripts/verify-gates.sh`, which plants one error per tool and asserts each tool fails. Then `packages/protocol` with its tests. Gate: `pnpm check` green, `verify-gates.sh` green.
2. **Apps, in parallel worktrees.** `acp-mux`, `typecheck`, `agent-worker`. Each owns its directory only. Gate per app: its tests green under `pnpm check`.
3. **End to end.** `scripts/e2e.ts` starts the local Worker (`alchemy dev`), the typecheck service and the mux, then drives ACP v1 through `nc -U`: initialize, session/new, session/prompt with a scripted model. Gate: the agent writes a file, a `diff` update arrives, the typecheck tool returns the planted error, the turn ends with `end_turn`, and `session/cancel` ends a second turn with `cancelled`.

## Out of scope for this run

Deploys, MCP over ACP (`mcpCapabilities.acp`), Executor injection, `session/load`, CI and preview-browser verification. Each is a follow-up once the end-to-end gate holds.

## Principle: compute efficiency

Agents run in Durable Objects, so an idle agent costs nothing and the agent count scales freely. No compute lives as long as an agent or a thread. Every piece of heavy work is a pure function of content hashes. It runs on a shared stateless pool, and its result is cached across all agents. Cost then scales with distinct work, not with agents times time. This is Bazel's remote-execution model (REAPI): a content-addressed store plus an action cache. The blob store and the per-lockfile installs in `apps/typecheck` already follow it.

The gaps beyond TypeScript (ad-hoc execution, semantic navigation, tools that write files back, and warm builds for compiled languages) must never be filled with per-thread containers or per-session language servers. Those bring back exactly the cost the DO design removes.

### Actions (Unit 2d)

- A check is the first kind of a generic action: a pure function of `{repo, commit, changed files by sha256, deleted paths, kind, toolchain}`, cached by its action digest.
- Repo registration, protected paths and `Rejected` apply to every kind. Only `check` exists. No other kind gets built until a unit needs it.
- `Diagnostic.tool` is an open tool name.
- An action result carries output file digests next to diagnostics, to be written back to the DO workspace later. For `check` the list is always empty.

### Later units

- **Ad-hoc execution.** An `exec` action on the shared pool, cached by action digest. Scratch JavaScript, Python (Pyodide) and wasm stay in the isolate. There is no REPL: code mode submits a whole experiment in one call. Evaluate existing REAPI servers (NativeLink, Buildbarn, BuildBuddy) before building a pool.
- **Navigation.** The check action also emits a SCIP index, cached by snapshot digest: one base index per commit, shared by every agent. tree-sitter or ast-grep in wasm covers the session's own edits inside the isolate. Queries run in the DO or against R2. No LSP.
- **Warm builds for compiled languages.** One base build cache per lockfile, plus a copy-on-write overlay per action. Never a cache per session.

### Claude subscription in the DOs (Unit 4)

Claude Code doesn't have to run. The DO needs only a Claude OAuth token. What's unsettled is billing. Anthropic's support page (article 15036540, updated 2026-10-27) says third-party app usage draws from plan limits. But on 2026-10-18 a stock Pi request with a Claude login got `400 Third-party apps now draw from your extra usage` (pi-claude-oauth `docs/architecture.md`). Anthropic classifies requests server-side, and nobody has published which request feature it keys on.

1. **Probe first.** Turn off extra usage at claude.ai/settings/usage, so a misclassified request fails with a 400 instead of billing per token. Make a fresh login with `pnpm claude-login`. Send one request in pi-ai's stock shape and one in pi-claude-subscription's shape. The result decides the path.
2. **If one shape draws from the plan:** one `ClaudeCredentials` DO per account holds `LoggedOut | Ready {access, refresh, expires}` and is the only actor that refreshes. Concurrent callers share one in-flight refresh, and each rotated refresh token is persisted before the access token is returned. A rejected refresh moves it to `LoggedOut`. The login is a fresh grant, never the laptop's Pi or Claude Code tokens.
3. **If neither does:** use the Max plan's monthly API credits (Max 5x $100, Max 20x $200, since 2026-10-07) through an API key from the linked Console organization. That path is documented for the Claude API and works from a DO with no token lifecycle.

### Session robustness (Unit 5)

One DO per ACP session instead of per connection, plus `session/load`. A reconnect, or T3's 30-minute idle unload, then reattaches to the same pi-durable session instead of starting over.
