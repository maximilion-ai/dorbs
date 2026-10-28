# CCR through the Agent SDK browser entry: offline research

2026-10-28. SDK 0.3.312, Claude Code 2.1.312. No live calls. Artifacts are in `/tmp/ccr-probe`. `bsdk:N` is a line in `/tmp/ccr-probe/pretty/browser-sdk.pretty.js` (the bundle run through prettier 3). "CLI" means `strings` over the `claude` ELF in `claude-agent-sdk-linux-x64` 0.3.312.

## Verdicts

| #   | Question                                | Verdict                                                                                                  |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Client protocol                         | **Works** (read and exercised offline)                                                                   |
| 2a  | Session creation                        | **Unknown.** Reverse-engineered from the CLI, not run                                                    |
| 2b  | Built-in tools off                      | **Works offline** through `canUseTool` deny. Create body has `config.disallowed_tools` (CLI), unverified |
| 2c  | Cloud worker calls client SDK MCP tools | **Unknown.** The critical live question                                                                  |
| 3   | Browser entry in workerd + DO           | **Works** with a dynamic `import()`                                                                      |
| 4   | Live probe                              | Written, not run.                                                                                        |

## 1. Client protocol (browser-sdk.js)

- **Startup.** `query()` (bsdk:44045) builds `BrowserSSETransport` (bsdk:36237) and `Query` (bsdk:16825). The constructor immediately sends `control_request{subtype:"initialize"}` (bsdk:16935, body at bsdk:17519). The body carries `sdkMcpServers: [names]`, hooks, and `jsonSchema`. `streamInput` writes user messages only after initialize is written (bsdk:18338).
- **Transport.** A `GET streamUrl` with `Accept: text/event-stream` (bsdk:36340). Each write is a `POST sendUrl` with body `{session_id, events:[{payload}]}` and a `uuid` injected (bsdk:36653, 36659). Accepted SSE events are `client_event` (durable, `{event_id, sequence_num, source, created_at, payload}`), `ephemeral_event` (`stream_event` and a few system frames), `delivery_update`, and `catch_up_truncated` (bsdk:36380–36540). The transport drops `control_request` and non-`user` payloads unless `source === "worker"` (bsdk:36536). Other limits: 45 s liveness timeout (bsdk:36218), 5 reconnects before failing (bsdk:36217), and 401/403/404 are fatal (bsdk:36222).
- **SDK MCP.** The worker sends `control_request{subtype:"mcp_message", server_name, message: <JSON-RPC>}`. The SDK routes it to the in-process server and answers with `control_response{response:{mcp_response: <JSON-RPC result>}}` (bsdk:17324, 17206).
- **Permissions.** The worker sends `control_request{subtype:"can_use_tool", tool_name, input, tool_use_id,…}`, which maps to `canUseTool(name, input, ctx)`. The reply is `{behavior:"allow"|"deny", …, toolUseID}` (bsdk:17257). A `control_cancel_request` aborts the callback's signal (bsdk:17245).
- **Turn end.** The worker sends `result`, then `system/session_state_changed{state:"idle"}`. With MCP or `canUseTool` set, the run ends on idle, or 600 s after the result (bsdk:17087–17121, 9023). The SSE iterator never ends by itself because `endInput()` is a no-op (bsdk:36720). The consumer must break on `result`.
- **Interrupt.** `q.interrupt()` sends `control_request{subtype:"interrupt"}` (bsdk:17681).
- **Resume.** `fromSequenceNum` seeds the cursor, which is sent as a `Last-Event-ID` header on connect (bsdk:36289, 36327). `getSseLastSequenceNum(q)` returns the resume point. `suspendSseStream` and `resumeSseStream` exist. Verified offline: `fromSequenceNum: 9` led to the server seeing `Last-Event-ID=9`, and the SDK yielded seq 10 and 11 only.

## 2. Session creation recipe and provenance

| Item              | Value                                                                                                                                                                                                                                               | Source                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Base              | `https://api.anthropic.com`                                                                                                                                                                                                                         | CLI                                             |
| Headers           | `Authorization: Bearer <oauth>`, `anthropic-version: 2023-06-01`, `anthropic-client-platform`, `x-organization-uuid`, `Content-Type: application/json`                                                                                              | CLI `AC()`/`U5e()`; bridge.mjs:33028            |
| Platform value    | The CLI sends `claude_code_sdk` for sdk-ts and `claude_code_cli` by default. claude-rc-api says `web_claude_ai` is load-bearing for event ingest                                                                                                    | CLI `My()`; claude-rc-api                       |
| Beta              | None on `/v1/code/*`. `anthropic-beta: ccr-byoc-2025-07-29` only on the legacy `/v1/sessions` path                                                                                                                                                  | CLI `bJo()`; claude-rc-api                      |
| Scope             | `user:sessions:claude_code`                                                                                                                                                                                                                         | claude-rc-api; onix #423; string present in CLI |
| List environments | `GET /v1/environment_providers` → choose `kind:"anthropic_cloud"` (kinds: `bridge`, `anthropic_cloud`, `byoc`, `snap`)                                                                                                                              | CLI                                             |
| Create (v1alpha2) | `POST /v1/code/sessions` `{title, environment_id, events:[{payload}], config:{sources, outcomes, model, cwd, append_system_prompt, custom_system_prompt, max_turns, allowed_tools, disallowed_tools, builtin_tools, …}}` → `{session:{id:"cse_…"}}` | CLI `b7n()`, `phn()`, `S7n()`                   |
| Archive           | `POST /v1/code/sessions/{id}/archive`, 200 or 409 means archived. There is no DELETE                                                                                                                                                                | CLI `FM()`; claude-rc-api                       |

**Correction to plan.md.** The only create call in the SDK bundles is bridge.mjs:33067 (`{title, bridge:{}, config:{cwd, model}}`). That call creates a **Remote Control** session. Its worker is a local process that attaches through `/bridge` (bridge.mjs:33214). Such a session does not run Claude Code on Anthropic's side. Only `environment_id` of kind `anthropic_cloud` gives a cloud container. Neither sdk.mjs nor browser-sdk.js contains a create call (probe: `grep -c 'v1/code/sessions'` gave 0 for both).

**Official:** the `/browser` entry, its SSE options, and the control protocol (CHANGELOG 0.3.267, 0.3.304, 0.3.307). **Reverse-engineered:** everything in the table.

**Built-in tools.** Denying them through `canUseTool` works at the protocol level. The worker still owns the container filesystem, so a tool that runs without a permission prompt (auto-allowed reads, for example) touches the container, not the DO. Send `config.disallowed_tools` as well. The CLI rejects some options for cloud sessions, bypassPermissions included.

## 3. workerd run (wrangler 4.152.0, `wrangler dev`, offline)

DO `Probe` (`/tmp/ccr-probe/worker`) registers MCP server `dorbs` with tool `ping`. `fake-ccr/server.mjs` emits worker frames.

**Blocker found and worked around.** A static import crashes at startup with `Uncaught Error: Disallowed operation called within global scope … generating random values`. The cause is `var bg = EN(Gx)` (bsdk:13786), which calls `crypto.randomUUID()` (bsdk:9341) at module top level. `await import("../vendor/browser-sdk.js")` inside the handler fixes it. Streams, timers, `AbortSignal.any`/`timeout`, and zod worked.

`curl /run`, trimmed:

```
[fake-ccr] SSE connect auth=present platform=web_claude_ai Last-Event-ID=-
[fake-ccr] POST <- control_request:initialize
[fake-ccr] initialize.sdkMcpServers=["dorbs"]
[fake-ccr] SSE -> seq=4 control_request mcp_message   (initialize, then tools/list)
[fake-ccr] POST <- control_response {"mcp_response":{"result":{"tools":[{"name":"ping",...}]}}}
[fake-ccr] canUseTool(ping) answer: {"behavior":"allow","updatedInput":{"msg":"hello"},"toolUseID":"toolu_fake1"}
[fake-ccr] canUseTool(Bash) answer: {"behavior":"deny","message":"Built-in tools are disabled; use the dorbs MCP tools.","toolUseID":"toolu_fake0"}
[fake-ccr] tool result received by fake worker: "pong:hello"
[fake-ccr] SSE -> seq=11 result:success
DO trace:
  canUseTool mcp__dorbs__ping -> allow
  canUseTool Bash -> deny
  ping handler ran inside DO id=656344c8ca78 msg=hello
  yield result:success          (lastSeq 11; GET /run 200 OK, 44ms)
```

Full output: `/tmp/ccr-probe/run-output.json`, `resume-output.json`, `fake-ccr/run.log`.

## 4. Live probe

`/tmp/ccr-probe/live-probe.ts` (not run). Run it with Node ≥ 23, which strips the types:

```
node /tmp/ccr-probe/live-probe.ts <token-file> <org-uuid> [env_id] [model]
```

It picks an `anthropic_cloud` environment, creates a session with `events: []` and `disallowed_tools`, and sends the prompt through `query()` with MCP tool `probe.ping` and a deny-all-but-MCP `canUseTool`. It prints the full `result` (`usage`, `total_cost_usd`, `modelUsage`, any cost, billing, or limit keys), archives the session, and exits 0 only if `ping` ran in-process.

Check the plan usage page before and after the run to see whether usage drew from plan limits.

## Risks

- **SDK MCP over CCR cloud (critical, unknown).** The browser entry declares `sdkMcpServers` on `initialize`. No evidence was found that a cloud worker honours a peer client's servers. The CLI says "this machine's MCP servers reach cloud sessions through the device link" (`remote_tool_call`, which the browser SDK deliberately leaves unanswered, bsdk:16716, 17250). If the worker ignores client MCP, the design fails. Only the live probe can answer this.
- **Undocumented API.** Create, list, and archive, the environment kinds, and the platform header can change without notice. A gate (`useCcrV2SessionCrud`) switches between `/v1/code/sessions` and `/v1/sessions`. Creating a session without `sources` may be refused ("repositoryRequiredBy" exists).
- **ToS.** Support article 15036540 sanctions the Agent SDK. Using the documented `/browser` entry fits that. Creating sessions through a reverse-engineered endpoint from a third-party server is not clearly covered. Ask Anthropic before shipping.
- **Where Claude Code runs.** In an Anthropic cloud container with its own filesystem and network. The DO only answers tool and permission calls. Container startup adds latency.
- **Rate limits and billing.** Unknown. Expect plan limits and `rate_limit_event` frames. `total_cost_usd` is an estimate, not a bill.
- **DO lifetime.** The query holds one long SSE fetch and needs a keepalive every 45 s. Eviction kills it. Resume with `getSseLastSequenceNum` and `fromSequenceNum` (verified offline).
