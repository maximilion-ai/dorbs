import { Workspace } from "@cloudflare/computer";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import type * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { makeAgent, type AgentHost, type Emit, type SessionRecord } from "./agent.ts";
import { ModelProvider, type ModelUnavailable } from "./ModelProvider.ts";
import { registerTools, WORKSPACE_ROOT, type ToolHost } from "./tools.ts";
import { RunOutcome } from "./Turn.ts";
import * as Typecheck from "./Typecheck.ts";
import { NOTHING_SENT, toSessionUpdates } from "./updates.ts";

export type ModelLayer = (
  env: Cloudflare.Env,
) => Layer.Layer<ModelProvider, Config.ConfigError | ModelUnavailable>;

const SYSTEM_PROMPT =
  "You are a coding agent working in a TypeScript workspace. Every path is relative to the workspace root. " +
  "Run the typecheck tool after you change code.";

const sessionKey = (sessionId: string) => `acp/session/${sessionId}`;

const outcomeOf = (status: "done" | "unanswered", reason: string | undefined): RunOutcome =>
  status === "done"
    ? RunOutcome.Answered()
    : reason === "aborted"
      ? RunOutcome.Aborted()
      : RunOutcome.Failed({ reason: reason ?? "unanswered" });

/**
 * One ACP connection: a hibernatable WebSocket carrying JSON-RPC lines, one Pi harness over this
 * object's SQLite, and one Computer workspace that all of the connection's sessions share.
 */
export const makeAcpConnection = (modelLayer: ModelLayer) =>
  class AcpConnection extends DurableObject {
    readonly runtime = ManagedRuntime.make(
      Layer.mergeAll(modelLayer(this.env), Typecheck.layer).pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(this.env))),
      ),
    );

    readonly workspace = new Workspace({ storage: this.ctx.storage });

    readonly toolHost: ToolHost = {
      workspace: this.workspace,
      typecheck: (files) =>
        this.runtime.runPromise(
          Effect.flatMap(Effect.service(Typecheck.Typecheck), (typecheck) =>
            typecheck.check(files),
          ),
        ),
    };

    readonly registry = (() => {
      const registry = createRegistry();
      registry.install({
        name: "dorbs",
        tools: registerTools(this.toolHost),
        sections: [{ key: "agent", render: () => SYSTEM_PROMPT, tag: false }],
      });
      return registry;
    })();

    readonly harness = new PiHarness({
      harness: async ({ storage, context, onWake }) => {
        const { provider } = await this.runtime.runPromise(Effect.service(ModelProvider));
        const models = createModels();
        models.setProvider(provider);
        await this.workspace.fs.mkdir(WORKSPACE_ROOT, { recursive: true });
        return Harness.open(storage, { models, registry: this.registry, onWake }, context);
      },
    });

    readonly lifecycle = Lifecycle.install(this).use(this.harness);

    readonly agent = makeAgent({
      newSessionId: () => crypto.randomUUID(),
      loadSession: (sessionId) => this.ctx.storage.kv.get<SessionRecord>(sessionKey(sessionId)),
      saveSession: (sessionId, record) => this.ctx.storage.kv.put(sessionKey(sessionId), record),
      run: (sessionId, record, prompt, signal, emit) =>
        this.run(sessionId, record, prompt, signal, emit),
    } satisfies AgentHost);

    override async fetch(request: Request): Promise<Response> {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      const line = typeof message === "string" ? message : new TextDecoder().decode(message);
      const send = (frame: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      };
      await Effect.runPromise(this.agent.handle(line, send));
    }

    override async webSocketClose(): Promise<void> {
      this.agent.cancelAll();
    }

    private async piSession(sessionId: string, record: SessionRecord): Promise<string> {
      if (record.piSession !== undefined) return record.piSession;
      const { model } = await this.runtime.runPromise(Effect.service(ModelProvider));
      const session = await this.harness.sessions.create();
      await session.setModel(model);
      this.ctx.storage.kv.put(sessionKey(sessionId), { ...record, piSession: session.id });
      return session.id;
    }

    private async run(
      sessionId: string,
      record: SessionRecord,
      prompt: string,
      signal: AbortSignal,
      emit: Emit,
    ): Promise<RunOutcome> {
      const pi = this.harness.session(await this.piSession(sessionId, record));
      const operationId = crypto.randomUUID();
      const settled = Promise.withResolvers<RunOutcome>();
      const stream = await pi.events();
      let sent = NOTHING_SENT;
      // The turn ends on the event that settles the submission, so every update of the run is sent before the reply.
      stream.start(async (events) => {
        for (const event of events) {
          const [next, updates] = toSessionUpdates(sent, event, record.cwd);
          sent = next;
          for (const update of updates) emit(update);
          if (event.type === "submission" && event.record.requestId === operationId) {
            const { status } = event.record;
            if (status === "done" || status === "unanswered") {
              settled.resolve(outcomeOf(status, event.record.reason));
            }
          }
        }
      });
      const abort = () => {
        pi.abort().catch((error: unknown) => console.error("Pi abort failed", error));
      };
      signal.addEventListener("abort", abort);
      try {
        if (signal.aborted) return RunOutcome.Aborted();
        await pi.submit(prompt, { operationId, whenBusy: "reject" });
        if (signal.aborted) abort();
        return await Promise.race([
          settled.promise,
          stream.closed.then((end) => RunOutcome.Failed({ reason: `event stream ${end.reason}` })),
        ]);
      } catch (error) {
        return RunOutcome.Failed({
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        signal.removeEventListener("abort", abort);
        await stream.stop();
      }
    }
  };
