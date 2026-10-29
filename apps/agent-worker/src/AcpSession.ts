import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import type { JsonRpcNotification, JsonRpcRequest } from "@dorbs/protocol/jsonrpc";
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

import * as GitHub from "./GitHub.ts";
import { ModelProvider, type ModelUnavailable } from "./ModelProvider.ts";
import * as Repos from "./Repos.ts";
import { nameOf, type ConnectionId } from "./rpc.ts";
import { makeSession, type Emit, type SessionHost, type SessionRecord } from "./session.ts";
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

const RECORD_KEY = "acp/session";
const ATTACHED_KEY = "acp/attached";
const CLONE_KEY = "workspace/clone";

const outcomeOf = (status: "done" | "unanswered", reason: string | undefined): RunOutcome =>
  status === "done"
    ? RunOutcome.Answered()
    : reason === "aborted"
      ? RunOutcome.Aborted()
      : RunOutcome.Failed({ reason: reason ?? "unanswered" });

/**
 * One ACP session, named by its sessionId: its turn, its Pi session over this object's SQLite, its Computer
 * workspace and cloned repo, and the history a session/load replays. It reaches clients through the
 * AcpConnection it is attached to.
 */
export const makeAcpSession = (modelLayer: ModelLayer) =>
  class AcpSession extends DurableObject {
    readonly runtime = ManagedRuntime.make(
      Layer.mergeAll(modelLayer(this.env), Typecheck.layer, Repos.layer, GitHub.layer).pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(this.env))),
      ),
    );

    readonly workspace = new Workspace({
      storage: this.ctx.storage,
      git: createGitClient(),
      defaultGitIdentity: { name: "dorbs agent", email: "agent@dorbs.invalid" },
    });

    readonly toolHost: ToolHost = {
      workspace: this.workspace,
      repos: () => this.runtime.runPromise(Effect.service(Repos.Repos)),
      clone: () => this.ctx.storage.kv.get<Typecheck.Clone>(CLONE_KEY),
      saveClone: (clone) => this.ctx.storage.kv.put(CLONE_KEY, clone),
      typecheck: (clone, change) =>
        this.runtime.runPromise(
          Effect.flatMap(Effect.service(Typecheck.Typecheck), (typecheck) =>
            typecheck.check(clone, change),
          ),
        ),
      github: () => this.runtime.runPromise(Effect.service(GitHub.GitHub)),
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

    readonly history = (() => {
      const { sql } = this.ctx.storage;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS acp_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL)",
      );
      return {
        remember: (message: string) => {
          sql.exec("INSERT INTO acp_history (message) VALUES (?)", message);
        },
        all: () =>
          sql
            .exec<{ message: string }>("SELECT message FROM acp_history ORDER BY seq")
            .toArray()
            .map((row) => row.message),
      };
    })();

    #outbox = Promise.resolve();

    readonly session = makeSession({
      sessionId: nameOf(this.ctx),
      record: () => this.ctx.storage.kv.get<SessionRecord>(RECORD_KEY),
      saveRecord: (record) => this.ctx.storage.kv.put(RECORD_KEY, record),
      attached: () => this.ctx.storage.kv.get<ConnectionId>(ATTACHED_KEY),
      attach: (connection) => this.ctx.storage.kv.put(ATTACHED_KEY, connection),
      remember: this.history.remember,
      history: this.history.all,
      send: (connection, message) => {
        const to = this.env.AcpConnection.getByName(connection);
        this.#outbox = this.#outbox
          .then(() => to.deliver(message))
          .catch((error: unknown) => console.error(`Could not deliver to ${connection}`, error));
      },
      run: (record, prompt, signal, emit) => this.run(record, prompt, signal, emit),
    } satisfies SessionHost);

    /** session/new: creates this session and attaches the connection that made it. */
    open(connection: ConnectionId, cwd: string): void {
      this.session.open(connection, cwd);
    }

    /** One frame for this session; resolves once the frame is accepted, before a prompt's turn ends. */
    receive(connection: ConnectionId, frame: JsonRpcRequest | JsonRpcNotification): Promise<void> {
      return Effect.runPromise(this.session.receive(connection, frame));
    }

    private async piSession(record: SessionRecord): Promise<string> {
      if (record.piSession !== undefined) return record.piSession;
      const { model } = await this.runtime.runPromise(Effect.service(ModelProvider));
      const session = await this.harness.sessions.create();
      await session.setModel(model);
      this.ctx.storage.kv.put(RECORD_KEY, { ...record, piSession: session.id });
      return session.id;
    }

    private async run(
      record: SessionRecord,
      prompt: string,
      signal: AbortSignal,
      emit: Emit,
    ): Promise<RunOutcome> {
      const pi = this.harness.session(await this.piSession(record));
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
