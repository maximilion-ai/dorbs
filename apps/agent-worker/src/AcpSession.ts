import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import type * as Acp from "@dorbs/protocol/acp";
import type { JsonRpcNotification, JsonRpcRequest } from "@dorbs/protocol/jsonrpc";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as GitHub from "./GitHub.ts";
import { tokenCache } from "./GitHubTokens.ts";
import { forgetBase, openBase, type Base } from "./base.ts";
import { keepBase } from "./cloneRepo.ts";
import { LayeredFs, type OverlayState } from "./layered.ts";
import type { Loop, LoopHost } from "./Loop.ts";
import { ModelChoices, ModelProvider, type ModelUnavailable } from "./ModelProvider.ts";
import { makeOpenCodeLoop } from "./OpenCodeLoop.ts";
import { makeOutbox } from "./Outbox.ts";
import { makePiLoop } from "./PiLoop.ts";
import * as Repos from "./Repos.ts";
import { nameOf, type ConnectionId } from "./rpc.ts";
import {
  makeSession,
  type HarnessName,
  type OpenPrompt,
  type SessionHost,
  type SessionRecord,
  type StreamedRun,
} from "./session.ts";
import { overlayFs } from "./overlay.ts";
import { type ToolHost, WORKSPACE_ROOT } from "./tools.ts";
import * as Checker from "./Checker.ts";

export type ModelLayer = (
  env: Cloudflare.Env,
) => Layer.Layer<ModelProvider, Config.ConfigError | ModelUnavailable>;

const RECORD_KEY = "acp/session";
const ATTACHED_KEY = "acp/attached";
const PROMPTS_KEY = "acp/prompts";
const CLONE_KEY = "workspace/clone";
const OVERLAY_KEY = "workspace/overlay";
/** The Lifecycle job that deletes this session once it has been idle for the retention period. */
const RETIRE = "retire";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RetentionDays = Config.Int("SESSION_RETENTION_DAYS").pipe(Config.withDefault(7));
/** The agent loop new sessions run on. */
const HarnessConfig = Config.Literals(["pi", "opencode"], "HARNESS").pipe(Config.withDefault("pi"));
/** Whether the runtime ends an event's storage transactions and RPCs with the event: celld does, workerd does not. */
const HoldEvents = Config.Boolean("HOLD_EVENTS").pipe(Config.withDefault(false));

/** History rows per replayed RPC; a row is at most 256 KiB, so a page stays under the 32 MiB RPC limit. */
const REPLAY_PAGE = 64;

/**
 * One ACP session, named by its sessionId: its turn, its agent loop (Pi or OpenCode) over this object's SQLite, its
 * Computer workspace and cloned repo, and the history a session/load replays. It reaches clients through the
 * AcpConnection it is attached to.
 */
export const makeAcpSession = (modelLayer: ModelLayer) =>
  class AcpSession extends DurableObject {
    readonly runtime = ManagedRuntime.make(
      Layer.mergeAll(
        modelLayer(this.env),
        Checker.layer,
        Repos.layer,
        GitHub.layer(tokenCache(this.env.GitHubTokens)),
      ).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(this.env)))),
    );

    readonly workspace: Workspace = new Workspace({
      storage: this.ctx.storage,
      // isomorphic-git works on the layered view, so a commit or a status reads through to the base.
      git: createGitClient({ adapter: async () => ({ promises: this.fs.promises }) }),
      defaultGitIdentity: { name: "dorbs agent", email: "agent@dorbs.invalid" },
    });

    /** The repo as the session sees it: what it wrote over the shared base of its clone. */
    #base: { readonly prefix: string; readonly ref: WeakRef<Base> } | undefined;

    readonly fs: LayeredFs = new LayeredFs({
      overlay: overlayFs(this.workspace.provider()),
      root: WORKSPACE_ROOT,
      state: this.ctx.storage.kv.get<OverlayState>(OVERLAY_KEY),
      save: (state) => this.ctx.storage.kv.put(OVERLAY_KEY, state),
      base: async () => {
        const prefix = this.ctx.storage.kv.get<Checker.Clone>(CLONE_KEY)?.base;
        if (prefix === undefined) return undefined;
        // Held weakly: the isolate's cache keeps the bases in use, and an idle session's costs nothing.
        const held = this.#base?.prefix === prefix ? this.#base.ref.deref() : undefined;
        if (held !== undefined) return held;
        const base = await openBase(this.env.Bases, prefix);
        if (base === undefined) throw new Error("The repo's base is gone. Clone the repo again.");
        this.#base = { prefix, ref: new WeakRef(base) };
        return base;
      },
    });

    readonly toolHost: ToolHost = {
      workspace: this.workspace,
      repos: () => this.runtime.runPromise(Effect.service(Repos.Repos)),
      clone: () => this.ctx.storage.kv.get<Checker.Clone>(CLONE_KEY),
      saveClone: (clone) => this.ctx.storage.kv.put(CLONE_KEY, clone),
      fs: this.fs,
      bases: {
        bucket: this.env.Bases,
        lease: (prefix) => this.env.RepoBase.getByName(prefix),
      },
      holder: () => nameOf(this.ctx),
      check: (clone, change, only) =>
        this.runtime.runPromise(
          Effect.flatMap(Effect.service(Checker.Checker), (checker) =>
            checker.check(clone, change, only),
          ),
        ),
      test: (clone, change, selection) =>
        this.runtime.runPromise(
          Effect.flatMap(Effect.service(Checker.Checker), (checker) =>
            checker.test(clone, change, selection),
          ),
        ),
      github: () => this.runtime.runPromise(Effect.service(GitHub.GitHub)),
    };

    /** The loop this session runs on: the one its record names, else the configured one, which open() records. */
    readonly harness: HarnessName = (() => {
      const record = this.ctx.storage.kv.get<SessionRecord>(RECORD_KEY);
      if (record !== undefined) return record.harness ?? "pi";
      return Effect.runSync(HarnessConfig.parse(ConfigProvider.fromUnknown(this.env)));
    })();

    /** The models a session may pick: every configured one on Pi; OpenCode runs the default only. */
    readonly choices = (() => {
      const choices = Effect.runSync(ModelChoices.parse(ConfigProvider.fromUnknown(this.env)));
      return this.harness === "opencode" ? choices.slice(0, 1) : choices;
    })();

    readonly prompts = (): ReadonlyArray<OpenPrompt> =>
      this.ctx.storage.kv.get<ReadonlyArray<OpenPrompt>>(PROMPTS_KEY) ?? [];

    readonly loop: Loop = (() => {
      const host: LoopHost = {
        storage: this.ctx.storage,
        record: () => this.ctx.storage.kv.get<SessionRecord>(RECORD_KEY),
        rejoining: () => {
          const [running] = this.prompts();
          return running?.started === undefined ? undefined : running.operationId;
        },
        models: () => this.runtime.runPromise(Effect.service(ModelProvider)),
        workspace: this.workspace,
        tools: this.toolHost,
        saveRecord: (record) => this.ctx.storage.kv.put(RECORD_KEY, record),
      };
      return this.harness === "opencode" ? makeOpenCodeLoop(host) : makePiLoop(host);
    })();

    readonly lifecycle = Lifecycle.install(this).use(this.loop.capability);

    readonly retentionMs =
      Effect.runSync(RetentionDays.parse(ConfigProvider.fromUnknown(this.env))) * DAY_MS;

    #baseUsedAt = 0;

    /**
     * Puts off deleting this session until it has been idle for the retention period from now, and its repo's base
     * for longer: a base outlives every session that used it.
     */
    private async touch(): Promise<void> {
      await this.lifecycle.jobs.push({
        id: RETIRE,
        fn: RETIRE,
        time: Date.now() + this.retentionMs,
      });
      const base = this.ctx.storage.kv.get<Checker.Clone>(CLONE_KEY)?.base;
      if (base === undefined || Date.now() - this.#baseUsedAt < HOUR_MS) return;
      const loaded = await this.fs.base().catch(() => undefined);
      if (loaded === undefined || !(await keepBase(this.toolHost.bases, loaded))) {
        // Its deletion is under way: reads now fail with the reason rather than find parts missing.
        this.#base = undefined;
        forgetBase(base);
        return;
      }
      this.#baseUsedAt = Date.now();
    }

    /** Deletes the history, the workspace and the agent loop's session, then resets this object so nothing stale lingers. */
    async onJob({ job }: LifecycleJobContext): Promise<void> {
      if (job.fn !== RETIRE) return;
      await this.ctx.storage.deleteAll();
      this.ctx.abort("Retired after its retention period", { retryAlarm: false });
    }

    /** Retires this session now rather than after the retention period: its alarm deletes it. */
    async purge(): Promise<void> {
      await this.lifecycle.jobs.push({ id: RETIRE, fn: RETIRE, time: Date.now() });
    }

    readonly history = (() => {
      const { sql } = this.ctx.storage;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS acp_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL)",
      );
      // The chunks of the streamed run in progress, one row each, until the run is kept as one history row.
      sql.exec(
        "CREATE TABLE IF NOT EXISTS acp_stream (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL)",
      );
      return {
        remember: (message: string) => {
          sql.exec("INSERT INTO acp_history (message) VALUES (?)", message);
        },
        hold: (kind: StreamedRun["sessionUpdate"], text: string) => {
          sql.exec("INSERT INTO acp_stream (kind, text) VALUES (?, ?)", kind, text);
        },
        release: (): StreamedRun | undefined => {
          const chunks = sql
            .exec<{
              kind: StreamedRun["sessionUpdate"];
              text: string;
            }>("SELECT kind, text FROM acp_stream ORDER BY seq")
            .toArray();
          const [first] = chunks;
          if (first === undefined) return undefined;
          sql.exec("DELETE FROM acp_stream");
          return { sessionUpdate: first.kind, text: chunks.map((chunk) => chunk.text).join("") };
        },
        /** Every row kept so far, a page at a time, read as the replay asks for it. */
        pages: () => {
          const last =
            sql.exec<{ last: number | null }>("SELECT max(seq) AS last FROM acp_history").one()
              .last ?? 0;
          return function* () {
            for (let after = 0; after < last;) {
              const rows = sql
                .exec<{ seq: number; message: string }>(
                  "SELECT seq, message FROM acp_history WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
                  after,
                  last,
                  REPLAY_PAGE,
                )
                .toArray();
              if (rows.length === 0) return;
              yield rows.map((row) => row.message);
              after = rows.at(-1)?.seq ?? last;
            }
          };
        },
      };
    })();

    readonly outbox = makeOutbox((connection, messages) =>
      this.env.AcpConnection.getByName(connection).deliver(messages),
    );

    readonly session = makeSession({
      sessionId: nameOf(this.ctx),
      record: () => this.ctx.storage.kv.get<SessionRecord>(RECORD_KEY),
      saveRecord: (record) =>
        this.ctx.storage.kv.put(RECORD_KEY, { ...record, harness: this.harness }),
      attached: () => this.ctx.storage.kv.get<ConnectionId>(ATTACHED_KEY),
      attach: (connection) => this.ctx.storage.kv.put(ATTACHED_KEY, connection),
      remember: this.history.remember,
      hold: this.history.hold,
      release: this.history.release,
      prompts: this.prompts,
      savePrompts: (prompts) => {
        if (prompts.length === 0) this.ctx.storage.kv.delete(PROMPTS_KEY);
        else this.ctx.storage.kv.put(PROMPTS_KEY, prompts);
      },
      replay: (connection) => this.outbox.replay(connection, this.history.pages()),
      choices: this.choices,
      setModel: (record) => this.loop.setModel(record),
      send: this.outbox.send,
      run: async (record, prompt, operation, signal, emit) => {
        try {
          return await this.loop.run(record, prompt, operation, signal, emit);
        } finally {
          // A turn can run on after its client is gone; the idle period starts when it ends.
          await this.touch();
        }
      },
    } satisfies SessionHost);

    readonly holdsEvents = Effect.runSync(HoldEvents.parse(ConfigProvider.fromUnknown(this.env)));

    /**
     * Keeps the current event open until its turns have ended and their messages are delivered, where the runtime
     * needs it. workerd lets a Durable Object's work run on, and logs a held event a restart cuts off as uncaught.
     */
    private holdEvent(): void {
      if (!this.holdsEvents) return;
      this.ctx.waitUntil(this.session.drained().then(() => this.outbox.idle()));
    }

    constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
      super(ctx, env);
      // A turn a restart cut off runs on and is answered; the loop's wake job is what restarts an evicted object.
      this.session.resume();
      this.holdEvent();
    }

    /** session/new: creates this session, attaches the connection that made it, and answers with its models. */
    async open(
      connection: ConnectionId,
      cwd: string,
    ): Promise<ReadonlyArray<Acp.SessionConfigOption>> {
      const configOptions = this.session.open(connection, cwd);
      await this.touch();
      return configOptions;
    }

    /** One frame for this session; resolves once the frame is accepted, before a prompt's turn ends. */
    async receive(
      connection: ConnectionId,
      frame: JsonRpcRequest | JsonRpcNotification,
    ): Promise<void> {
      await this.touch();
      await Effect.runPromise(this.session.receive(connection, frame));
      this.holdEvent();
    }
  };
