# Platform APIs: Effect, Alchemy, Computer, Pi harness

Researched 2026-10-28. Versions come from `npm view`. Package paths point to tarballs unpacked under `/tmp/platform-probe/pkgs/`. The probe app is `/tmp/platform-probe/app`.

## 1. Effect

- Effect 4 is stable. `effect@4.0.0` shipped 2026-10-01, and `latest` is 4.0.7 (published 2026-10-28). `effect@3` is now the `prev` tag (3.22.4).
- Layout (`effect@4.0.7/package.json` exports): the platform code now lives in core. Import `effect/http/*`, `effect/socket/*`, `effect/rpc/*`, `effect/Schema`, and `effect/ManagedRuntime`. `@effect/platform` (0.97.x) and `@effect/schema` (0.75.5) belong to the v3 line, so don't use them. The Effect 4 companions are `@effect/platform-node`, `@effect/vitest`, and `@effect/sql-sqlite-do` (SQLite in a DO), all at 4.0.7.
- Cloudflare: `@effect/platform-workers` and `@effect/platform-cloudflare` don't exist (npm 404). `effect/workers` covers Web Workers, not Cloudflare. Alchemy is the Effect-native Cloudflare layer (§2).
- In a plain DO, give each instance one `ManagedRuntime.make(layer)` field and call `runtime.runPromise(...)` from methods. The probe ran this inside a DO (`/tmp/platform-probe/app/src/index.ts`). Effect 4 services use `class X extends Context.Service<X, Shape>()("X")` and `yield* X`. `X.asEffect` doesn't exist; the probe failed when it tried.
- WebSocket: use hibernatable `ctx.acceptWebSocket` or `agents/websockets` (the harness example uses the latter: `agents-src/examples/next/harnesses/pi/src/server.ts`). Decode ACP frames with `effect/Schema` inside the runtime.
- T3 Code (`/tmp/t3src/t3code/pnpm-workspace.yaml` catalog, commit 125b619): `effect`, `@effect/platform-node`, `@effect/vitest`, and `@effect/sql-sqlite-do` are all 4.0.5. `alchemy` and `@alchemy.run/cloudflare` are both 2.0.0-beta.84. T3 also patches both packages so they import `vite-plus` (`patches/alchemy@2.0.0-beta.84.patch`).

## 2. Alchemy

- `alchemy@2.0.0-beta.84` ("Infrastructure as Effects for TypeScript") is the `latest` tag. It has peer dependencies on `effect ^4.0.5` and `@effect/platform-node ^4.0.5`. Providers ship as `@alchemy.run/*` packages, including `cloudflare`, `docker`, and `kubernetes`. `@alchemy/effect` doesn't exist.
- Two Worker styles. An Effect-native Worker or DO uses `Cloudflare.DurableObject<...>()("Name")` with Effect methods (T3: `infra/relay/src/hooks/HookInboxObject.ts`). An async Worker uses `main` plus `env` bindings (`@alchemy.run/cloudflare/src/Workers/Worker.ts:799`, where "`env` is the only option for async Workers"). `withWorkspace`/`Workspace` and `Lifecycle.install(this)` need a native `DurableObject` subclass, so use the async style. One docs mismatch: `DurableObject.ts:1045` shows `bindings:`, but the prop is `env`.
- Storage defaults to SQLite (`DurableObject.ts:255`). Secrets are `Config.Redacted(...)` values in `env`, bound as `secret_text` (`Worker.ts:777`) and resolved by the Stack `secrets` providers.

Minimal `alchemy.run.ts`. The probe ran it with `alchemy dev`:

```ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Secrets from "alchemy/Secrets";
import type { Agent } from "./src/index.ts";

export const Worker = Cloudflare.Worker("AgentWorker", {
  main: "./src/index.ts",
  compatibility: { date: "2026-10-01", flags: ["nodejs_compat"] },
  env: {
    Agent: Cloudflare.DurableObject<Agent>("Agent"),
    LOADER: Cloudflare.WorkerLoader(),
    Bucket: Cloudflare.R2.Bucket("Bucket"),
    OPENROUTER_API_KEY: Config.Redacted("OPENROUTER_API_KEY"),
  },
  dev: { port: 8798 },
});
export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export default Alchemy.Stack(
  "PlatformProbe",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
    secrets: [Secrets.DotEnv(), Secrets.ProcessEnv()],
  },
  Effect.gen(function* () {
    return { url: (yield* Worker).url };
  }),
);
```

- Containers: `Cloudflare.Container<Cls>("X", { image })` in `env` creates the DO binding and the ContainerApplication together (`Containers/Container.ts:218-255`). I didn't check whether it can express Computer's `scheduling_policy: "durable_object"` setup. Docker: `@alchemy.run/docker` manages images, containers, and volumes through the active Docker context. Dokploy has no provider (`@alchemy.run/dokploy` returns 404), so it stays outside Alchemy.

## 3. Cloudflare Computer

- `@cloudflare/computer@0.8.0`. Its one dependency is `capnweb`. It needs `nodejs_compat`. Repo: github.com/cloudflare/computer @071b2b2.
- These are stable (README "Status"): `Workspace`, the SQLite FS, `WorkerJavaScriptBackend`, git, `ws:git`, and the tools. `WorkerShellBackend` is experimental and needs the `experimental` flag. The container backend is experimental.
- In a DO: `new Workspace({ storage: ctx.storage, git: createGitClient(), backends: [new WorkerJavaScriptBackend({ id, loader: env.LOADER, root: "/workspace", access: "read-write", modules: { "ws:git": createGitModule() } })] })`.
- `fs`: `readFile`, `writeFile`, `mkdir`, `readdir`, `rm`, and `grep` (README "The filesystem").
- Diff: `workspace.git.diff({ dir, ref?, to?, paths? })` returns a unified-diff string, and `diffSummary` returns A/M/D entries (`dist/shared-BbpnqJrh.d.ts:521,1017`).
- Isolate: `workspace.runtime.exec(moduleSource, { backend })` runs a module. Inside it, `ws:git` exposes `clone`, `status`, `diff`, `log`, and `cli`. Network access needs `allowNetwork: true` (`docs/17_isolate_javascript.md:408`).
- Tools: `createPiTools({ workspace })` returns `{ tools, execute }` (`read`, `ls`, `find`, `grep`, `write`, `edit`, `delete`, `exec`). `examples/pi-ai/src/index.ts` drives a hand-written loop with these. `examples/think` uses `@cloudflare/think` plus a container.
- Gotcha: `@cloudflare/computer/git` throws unless the optional peer `@platformatic/vfs` is installed. The README says that peer is only for Node. I hit this in the probe.

## 4. Agents SDK Pi harness

- `agents@0.31.0` provides `agents/harness/pi` (`PiHarness`), `agents/models/pi-ai` (`createAI`), and `agents/lifecycle`. Its optional peers are `@earendil-works/pi-ai`, `pi-durable`, and `chord`, all pinned to `~1.4.0` (latest 1.4.0). pi-durable is "Experimental. The API changes without notice" (`pi-durable/README.md:3`).
- Loop: `harness = new PiHarness({ harness: ({storage, context, onWake}) => Harness.open(storage, { models, registry, onWake }, context), defaults: { model } })` plus `Lifecycle.install(this).use(harness)`, then `harness.prompt()` / `submit()` (`agents/docs/harnesses/pi.md`).
- Lifecycle needs a named DO (`getByName`/`idFromName`); with `newUniqueId` the probe threw.
- Tools: `registry.install({ name, tools: ToolRegistration[] })`. To adapt the Computer tools, use `createWorkspaceTools` from `cloudflare/agents` `examples/next/harnesses/pi/src/workspace.ts` @786d30e.
- Models: Workers AI and AI Gateway go through `createAI({ binding: env.AI })` (`agents/docs/models-pi-ai.md`). OpenRouter goes through `openrouterProvider()` from `@earendil-works/pi-ai/providers/openrouter`, which reads `OPENROUTER_API_KEY` (`openrouter.js:66`). I didn't test OpenRouter in a Worker.
- Fake model: create `fauxProvider()` and register it with `models.setProvider(faux.provider)`. `faux.setResponses([fauxAssistantMessage([fauxToolCall("write", {...})], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("done")])])` drives a scripted run, and the probe used exactly this.
- Streaming: `harness.session().events()` returns `{ snapshot, start(cb), stop() }` (`pi-durable/dist/harness/events.d.ts:173`). Its events are `message_start`/`message_update`/`message_end` (text and thinking deltas), `tool_execution_start`/`tool_execution_update`/`tool_execution_end`, `run_start`/`run_end`, `turn_*`, `usage_changed`, and `task_failed`. These map onto ACP `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, and `tool_call_update`.
- Limits: there's no approval flow. `hook(ToolTask, { beforeTool })` can block or rewrite a call and may return a Promise (`types.d.ts:781,809`), so an ACP `session/request_permission` could live there. I haven't checked how that behaves under eviction or replay. `createPiTools` has no `approve` option; only the TanStack tools do.

## 5. Local testing (all offline, run in `/tmp/platform-probe/app`)

One DO did all of this: an Effect runtime, workspace write, git init and commit, a Pi run where the faux model called `write`, `git.diff`, and an isolate `exec` that imported `ws:git`.

| Runner                                   | Result                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wrangler dev` 4.154.0                   | Pass. The diff contained `+two`, and the event list included `tool_execution_end`.                                                                                                         |
| `alchemy dev`                            | Pass, with no Cloudflare credentials (`env -i`, empty HOME). Alchemy created the Worker and R2 locally and kept state in `.alchemy/`. The `/secret` route saw the secret and `Bucket.put`. |
| `@cloudflare/vitest-pool-workers` 0.23.0 | Fail. It is deprecated and renamed, and it pins wrangler 4.124.0, whose workerd rejects compat dates after 2026-08-22.                                                                     |
| `@cloudflare/vitest-plugin` 1.4.9        | Pass (1 test, 5 s). It failed as expected when I seeded a wrong assertion.                                                                                                                 |

## 6. Recommendation for `apps/agent-worker`

- Use an async Alchemy Worker with a native DO class. Effect runs through a per-DO `ManagedRuntime`. The DO holds a `Workspace` with `WorkerJavaScriptBackend` and `PiHarness`, with the faux model in tests.
- deps: `@cloudflare/computer@0.8.0`, `@platformatic/vfs@0.5.0`, `agents@0.31.0`, `@earendil-works/pi-ai@1.4.0`, `@earendil-works/pi-durable@1.4.0`, `@earendil-works/chord@1.4.0`, `effect@4.0.6`, `zod@^4.4.3`
- devDeps: `alchemy@2.0.0-beta.84`, `@alchemy.run/cloudflare@2.0.0-beta.84`, `@effect/platform-node@4.0.6`, `@effect/vitest@4.0.6`, `@cloudflare/vitest-plugin@1.4.9`, `vitest@^4.1`, `wrangler@4.154.0`, `@cloudflare/workers-types@5.20261027.1`
- `pnpm-workspace.yaml` needs `allowBuilds: { esbuild: true, workerd: true }`.
- Blockers and gotchas:
  - (a) pnpm's `minimumReleaseAge` rejects `effect@4.0.7` and `workers-types@5.20261028.1` today, so pin 4.0.6 until tomorrow.
  - (b) Alchemy is a beta pinned to an exact version, and pi-durable is experimental and pinned to a minor.
  - (c) The install pulls three workerd versions (wrangler, alchemy runtime, vitest-plugin).
  - (d) Approvals are custom work.
