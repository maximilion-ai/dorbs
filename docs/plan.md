# Build plan: isolate-backed T3 threads

T3 Code launches `/usr/bin/nc -U <socket>` as a Local ACP command. `acp-mux` relays each socket connection to the agent Worker over one WebSocket. Durable Objects are the ACP agent: one per connection that routes frames, and one per ACP session that does the work. Type checks go to one shared service.

Research behind every choice: `docs/research/t3-conventions.md`, `docs/research/acp-contract.md`, `docs/research/platform-apis.md`. Decisions: `docs/decisions.tsv`.

## Data shapes

**`packages/protocol`** (Effect Schema, shared by all apps)

- `JsonRpcFrame`: union of `Request {id, method, params}`, `Notification {method, params}`, `Response {id, result} | {id, error}`. Parsed once at each wire boundary.
- ACP v1 subset, vendored from T3's `packages/effect-acp` v1 schemas (MIT, commit `125b619`): `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/update`, `session/request_permission`.
- Type-check API with branded `Sha256` and `RelativePath`:
  - `CheckRequest {lockfile: Sha256, files: ReadonlyArray<{path: RelativePath, sha256: Sha256}>}`
  - `CheckResponse = MissingBlobs {sha256s} | CheckResult {diagnostics, durationMs}`
  - `Diagnostic {tool: "tsrs" | "oxlint", path, line, column, code, message, severity}`

**`apps/agent-worker`** (Worker + one `AcpConnection` DO per connection + one `AcpSession` DO per ACP session)

- The Worker routes `GET /acp?connection=<id>` to the `AcpConnection` DO named `<id>`. It holds the WebSocket, answers `initialize`, creates an `AcpSession` on `session/new`, and hands every frame with a `sessionId` to the `AcpSession` of that name.
- An `AcpSession` holds the turn state machine: `Idle | Prompting {requestId, abort} | Cancelling {requestId}`. `session/cancel` always resolves the open prompt with `stopReason: "cancelled"`.
- The Computer workspace is the session DO's files. Pi runs the agent loop. Tools are workspace read/write/edit/list/grep, isolate shell, git commit/push, and `typecheck`.
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

Deploys, MCP over ACP (`mcpCapabilities.acp`), Executor injection, CI and preview-browser verification. Each is a follow-up once the end-to-end gate holds.

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

### Claude subscription (Unit 4: not built)

Anthropic's [legal page](https://code.claude.com/docs/en/legal-and-compliance) sets the envelope: the Claude Code binary must run unmodified, developers may not collect, store or intermediate Claude.ai credentials or session tokens, and plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK". Raw OAuth from Pi, the Agent SDK browser entry against `/v1/code/sessions`, a Claude Code port to DOs, and cloud sessions all fail that envelope or can't be driven from a DO (docs/research/ccr-browser-sdk.md).

- Subscription threads run in T3's own Claude provider on the user's machine, as today. A turn runner in acp-mux would save almost nothing over that, so it isn't built.
- Bulk parallel threads use API keys with pi-durable in DOs. That's where the DO design pays off.
- Local Claude threads can still use the shared type-check service and Executor over MCP.

### Session robustness (Unit 5)

One DO per ACP session instead of per connection, plus `session/load`. A reconnect, or T3's 30-minute idle unload, then reattaches to the same pi-durable session instead of starting over.

- **Objects.** `AcpSession`, named by sessionId, owns the turn, the Pi session, the workspace, the cloned-repo record, the attached connection id and the history. `AcpConnection` stays thin and keeps no state beyond its WebSocket.
- **Delivery.** A session sends every frame by name: `AcpConnection.getByName(id).deliver(message)`, in order through one outbox. No callback stubs, so either object can hibernate or restart between frames. A response goes to the connection that sent the request. Updates go to the attached connection.
- **Attach.** `session/new` and `session/load` attach the connection that sent them, replacing the one before. Other frames from a connection that is not attached get `-32600`.
- **History.** Every `session/update` the session sends, plus each prompt as `user_message_chunk` and each turn's end as `session_info_update` with `_meta["dorbs/turnEnded"] = {stopReason} | {error}`, in one SQLite table. ACP v1 has no update that ends a turn, so the end is a `_meta` extension.
- **Load.** Attach, replay the history as `session/update` notifications, then answer `{}`. An unknown session answers `-32002 Unknown session <id>`. A second load replays the same history again.
- **Dropped connection.** The turn runs on. Its later updates go to the history and to whoever attaches. When it ends, the end goes to the history, and to the attached connection as the `turnEnded` notification if that connection did not send the prompt.
- **Order.** A session takes each frame and returns before a prompt's turn ends; the connection hands frames on one at a time, so a cancel never overtakes its prompt.
- **Unit 4.** A DO-initiated frame such as `_dorbs/runTurn` goes out through the same `deliver`. acp-mux's response comes back to the `AcpConnection`, which today drops responses; Unit 4 routes them to the session that sent the request.

How T3 sees a reconnect (T3 `125b619`):

1. nc exits. T3 marks the open turn failed with `transport_error` and respawns nc on the next turn.
2. T3 sends `initialize`, sees `loadSession: true`, and sends `session/load` with the thread's stored sessionId.
3. T3 drops every `session/update` for the loading session while the load runs, so the replay never shows twice in the thread.
4. T3 sends the user's next prompt. The model sees the earlier turns, including any that finished after the drop, and the workspace keeps every file. Updates of a turn that finished while nc was gone show in T3 only through the model's next answer.
5. If that earlier turn still runs, the new prompt gets `-32600 Prompt <id> is still running in this session`.
6. If the session is unknown, T3 starts a fresh runtime with `session/new` and reports the load failure for the old session.
