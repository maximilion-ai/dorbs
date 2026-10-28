# T3 Code ACP contract for a local-command agent

T3 Code `main` @ 125b619 (`/tmp/t3src/t3code`). `RT` = `packages/provider-acp/src/server/AcpSessionRuntime.ts`, `AD` = `packages/provider-acp/src/server/adapter.ts`, `CL` = `packages/effect-acp/src/client.ts`, `REG` = `packages/provider-acp-registry/src/server/`.

## 1. Transport

- **Spawn.** T3 launches local commands with `{ command, args: settings.commandArgs, cwd, env, shell: false }` (`REG/AcpRegistrySupport.ts:1831`). Args are literal; no shell. `cwd` is the thread's project cwd (`AD:1983`).
- **Env.** Session runs add `T3_ACP_MCP_ENDPOINT`, `T3_ACP_MCP_AUTHORIZATION`, `T3_ACP_MCP_NODE` and optionally `T3_ACP_MCP_ENTRYPOINT` to the spawn env (`AD:621-626`, merged at `REG/adapter.ts:164`). It's a local URL the DO can't reach; use §4.
- **Framing.** Each frame is one JSON-RPC 2.0 object followed by `\n` (`packages/effect-acp/src/protocol.ts:165-180`). A malformed line ends the session (`protocol.ts:163`). Undecodable notifications are dropped (`protocol.ts:528`).
- **stderr.** T3 keeps the last 4 KiB, redacts it, and attaches it to the exit error (`stderr.ts:1`, `RT:1624-1640`, `RT:1286-1310`).
- **Exit.** On exit T3 records `ConnectionTerminated` and fails the active turn with `transport_error`. It sets `runtimeRestartRequired` (`AD:1943-1972`) and respawns on the next turn (`AD:7283`).
- **Probe.** When you add or refresh a provider, T3 spawns the command with cwd = server cwd (`REG/driver.ts:570`). It runs `initialize` and then `session/new` with `mcpServers: []` (`REG/probe.ts:339-415`). It waits up to 500 ms for `available_commands_update` (`probe.ts:48,423`). The whole probe has a 60 s limit (`probe.ts:46,430`). The picker's models come from this response (`probe.ts:255-260`). Every refresh makes a throwaway session, so keep `session/new` cheap.

## 2. Version negotiation

T3 always sends `protocolVersion: 2` (`RT:2042`). The request carries both the v2 fields (`info`, `capabilities`) and the v1 fields (`clientInfo`, `clientCapabilities`) (`CL:681-702`, `rpc.ts:145`). It picks v2 only if the response has an `info` key. Otherwise it treats the agent as v1 (`CL:705-709`, `CL:1081-1089`). Client caps: fs and terminal `false`, `elicitation.form` (`AD:1993-2000`).

Minimal v1 response:

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "dorbs", "version": "0.1.0" },
  "agentCapabilities": {
    "loadSession": false,
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false },
    "mcpCapabilities": { "acp": true }
  },
  "authMethods": []
}
```

**Recommendation: pin v1.**

- v1 `session/prompt` returns `{stopReason}` directly. In v2 the prompt response is only an ack. The turn ends when the agent sends a `state_update` `idle` notification (`CL:813-830`, `CL:1246-1270`).
- In v2, any `capabilities.session` object makes T3 assume `loadSession`, `list`, `resume` and `close` (`CL:586-604`). The `mcp.acp` flag also lives under `session`, so MCP-over-ACP in v2 forces all four.
- v1 is stable (schema-v1.21.0); v2 is alpha.3 (`packages/effect-acp/scripts/generate.ts:16-17`).

## 3. One turn

1. **`session/new`** sends `{cwd, mcpServers, additionalDirectories?}` (`RT:2194`). With `mcpCapabilities.acp` set, `mcpServers` is `[{type:"acp",name:"t3-code",serverId:"t3-code"}]` (`AD:619`, `RT:2090-2101`). Without it, T3 sends a local stdio bridge command that a remote agent can't run (`AD:606-617`). The response needs `sessionId`.
   - **Models.** T3 reads models from a `configOptions` entry with `category:"model"`, `type:"select"`, `currentValue` and `options` (`runtimeModel.ts:414`, `REG/probe.ts:173-203`), or from the unstable `models.availableModels`. With no models, the picker shows a single `default` (`REG/driver.ts:98-108`). To switch models, T3 calls `session/set_config_option {sessionId, configId, value}`, and skips the call when the value already matches (`AD:6680-6696`).
2. **`session/prompt`** sends `{sessionId, prompt:[{type:"text",text}]}`. Images are rejected unless `image` is advertised (`AD:7211`).
3. **`session/update`** notifications carry `{sessionId, update:{sessionUpdate,...}}`. T3 renders these kinds (`runtimeModel.ts:1320-1600`):
   - `agent_message_chunk` / `agent_thought_chunk` with `{content:{type:"text",text}}`
   - `tool_call` with `{toolCallId,title,kind,status,locations?,rawInput?,content?}`
   - `tool_call_update` with `{toolCallId,status?,content?}`, where `content` may contain `{type:"diff",path,oldText?,newText}` (`runtimeModel.ts:371-384`) or `{type:"content",content}`
   - `plan` with `{entries:[{content,priority,status}]}`
   - `usage_update` with `{used,size,cost?}` (`runtimeModel.ts:1544`)
   - `available_commands_update`, `session_info_update`, `config_option_update`

4. **Response** `{stopReason, usage?}`. v1 values: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` (`schema-v1.gen.ts:1174`). Non-`cancelled` means completed (`AD:7618-7625`).
5. **`session/cancel`** is a notification `{sessionId}`. By default T3 only sends it and keeps waiting for the prompt response (`RT:2318-2320`, `AD:1991`), with no timeout on that path. The agent must answer the open `session/prompt` with `stopReason:"cancelled"`, or the turn hangs.

## 4. MCP over ACP

All MCP traffic flows from the agent to T3 on the same stdio stream (`packages/effect-acp/src/_generated/meta.gen.ts:32-40`, `AD:5909-5920`, `mcpOverAcpBridge.ts`):

| Method           | Kind                 | Params                            | Result               |
| ---------------- | -------------------- | --------------------------------- | -------------------- |
| `mcp/connect`    | request              | `{serverId:"t3-code"}`            | `{connectionId}`     |
| `mcp/message`    | request              | `{connectionId, method, params?}` | the raw MCP `result` |
| `mcp/message`    | notification (no id) | `{connectionId, method, params?}` | none                 |
| `mcp/disconnect` | request              | `{connectionId}`                  | `{}`                 |

- **Server id.** Only `serverId` `t3-code` is accepted. Max 16 connections, 8 MiB per message (`mcpOverAcpBridge.ts:8-9`).
- **Handshake:** `initialize`, `notifications/initialized`, then `tools/list`/`tools/call`, all via `mcp/message`.
- **Errors** return as JSON-RPC `-32603` (`AD:5901-5907`).

## 5. Permissions

- **Request.** The agent sends `session/request_permission` `{sessionId, toolCall: ToolCallUpdate, options:[{optionId,name,kind: allow_once|allow_always|reject_once|reject_always}]}` (`schema-v1.gen.ts:6459`, `3137`).
- **Response.** T3 answers `{outcome:{outcome:"selected",optionId}}` or `{outcome:{outcome:"cancelled"}}`.
- **Rules by kind and mode** (`clientPolicy.ts:142-185`, `AD:6000-6040`):
  - `read`, `search` and `think` are always allowed.
  - Supervised asks the user.
  - `workspaceWrite` allows edit, delete and move only when every `locations[].path` is inside the local cwd or a writable root. Otherwise it denies. Remote paths outside the local cwd get denied, so report paths under the T3 `cwd`.
  - Full access allows everything.
  - Auto-approve picks `allow_once` first (`AD:992`). Deny picks `reject_once`. If the matching kind is missing, T3 returns `cancelled`.
- **No requests:** T3 enforces nothing (`docs/user/providers-acp.md:111-116`).

## 6. Prototype checklist

**Implement:**

- `initialize` (v1 shape above)
- `session/new`
- `session/prompt`
- `session/cancel` (notification)
- `session/update` with `agent_message_chunk`, `tool_call`, `tool_call_update` (diff) and `plan`
- `session/set_config_option`, only if more than one model is advertised
- `mcp/*` client calls; optional `session/request_permission`; `-32601` for unknown methods

**Don't advertise:**

- **`sessionCapabilities.resume`.** `loadSession` covers reconnects; see §8. Advertise `loadSession` only while replay works.
- **`sessionCapabilities.fork`, `list`, `delete`, `close`.** They enable UI paths (`REG/probe.ts:267-272`).
- **`authMethods`.** Keep the list empty. A non-`agent` method can't run headless (`RT:2126-2134`), and a `-32000` error makes T3 report "authentication failed" (`REG/probe.ts:283-285`).
- **Client fs/terminal.** T3 sends `false`; never call `fs/*` or `terminal/*`.
- **`image`, `audio`, `embeddedContext`** until handled.

## 7. Reusing `packages/effect-acp`

- **Dependencies.** The only runtime dependency is `effect` (`package.json`, catalog `effect: 4.0.5`, `pnpm-workspace.yaml:70`). It has no `@t3tools/*` imports. The package is private, with TS-source exports: `./schema`, `./schema-v1`, `./agent`, `./client`, `./rpc`, `./protocol`, `./errors`, `./compat`.
- **v1 schemas are reusable.** `schema-v1.gen.ts` is a self-contained file of `effect/Schema` codecs that imports only `effect/Schema` (line 1). Vendor it to validate v1 frames in the DO.
- **The agent helper speaks v2 only.** `AcpAgent` is built on `AgentRpcs`, which uses the v2 `schema.gen.ts` codecs (`agent.ts:13,220,278`, `rpc.ts:31-107`). It needs an `effect/Stdio` (`agent.ts:554`). A hand-rolled NDJSON dispatcher over the v1 schemas is less work than adapting it.

## 8. `session/load` (advertised since Unit 5)

- **When.** T3 calls `session/load` when it respawns a thread's command and `loadSession` is `true` (`RT:2163-2177`, `AD:6620-6643`). Params are `{sessionId, cwd, mcpServers}` (`RT:2167-2172`).
- **Replay.** While the load runs, T3 drops every `session/update` for the loading session (`RT:1693-1735`). Updates marked `_meta.isReplay: true` are dropped at any time (`runtimeModel.ts:1211-1214`). So replay never renders twice; T3 keeps its own transcript.
- **End.** T3 takes the load response, or a 2 s gap after the last replayed update, whichever comes first (`RT:81`, `runtimeModel.ts:1261-1275`). The whole load has a 90 s limit (`RT:80`).
- **Unknown session.** Answer JSON-RPC `-32002` (ACP `resource_not_found`, `schema-v1.gen.ts:1399`). T3 then starts a fresh runtime with `session/new` and reports the failure for the old session (`AD:6593-6616`, `AD:6633-6638`).
- **Turn end.** v1 has no update that ends a turn. This agent keeps each turn's end in the history as `session_info_update` with `_meta["dorbs/turnEnded"]`. T3 turns a live `session_info_update` into a `SessionInfoUpdated` event with only the fields it knows (`runtimeModel.ts:1557-1568`).
