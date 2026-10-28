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
