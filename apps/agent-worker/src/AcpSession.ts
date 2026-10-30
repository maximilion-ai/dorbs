import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import type { JsonRpcNotification, JsonRpcRequest } from "@dorbs/protocol/jsonrpc";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as GitHub from "./GitHub.ts";
import type { Loop, LoopHost } from "./Loop.ts";
import { ModelProvider, type ModelUnavailable } from "./ModelProvider.ts";
import { makeOpenCodeLoop } from "./OpenCodeLoop.ts";
import { makeOutbox } from "./Outbox.ts";
import { makePiLoop } from "./PiLoop.ts";
import * as Repos from "./Repos.ts";
import { nameOf, type ConnectionId } from "./rpc.ts";
import { makeSession, type HarnessName, type SessionHost, type SessionRecord } from "./session.ts";
import type { ToolHost } from "./tools.ts";
import * as Typecheck from "./Typecheck.ts";

export type ModelLayer = (
  env: Cloudflare.Env,
) => Layer.Layer<ModelProvider, Config.ConfigError | ModelUnavailable>;

const RECORD_KEY = "acp/session";
const ATTACHED_KEY = "acp/attached";
const CLONE_KEY = "workspace/clone";
/** The Lifecycle job that deletes this session once it has been idle for the retention period. */
const RETIRE = "retire";
const DAY_MS = 24 * 60 * 60 * 1000;
const RetentionDays = Config.Int("SESSION_RETENTION_DAYS").pipe(Config.withDefault(30));
/** The agent loop new sessions run on. */
const HarnessConfig = Config.Literals(["pi", "opencode"], "HARNESS").pipe(Config.withDefault("pi"));

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

    /** The loop this session runs on: the one its record names, else the configured one, which open() records. */
    readonly harness: HarnessName = (() => {
      const record = this.ctx.storage.kv.get<SessionRecord>(RECORD_KEY);
      if (record !== undefined) return record.harness ?? "pi";
      return Effect.runSync(HarnessConfig.parse(ConfigProvider.fromUnknown(this.env)));
    })();

    readonly loop: Loop = (() => {
      const host: LoopHost = {
        storage: this.ctx.storage,
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

    /** Puts off deleting this session until it has been idle for the retention period from now. */
    private async touch(): Promise<void> {
      await this.lifecycle.jobs.push({
        id: RETIRE,
        fn: RETIRE,
        time: Date.now() + this.retentionMs,
      });
    }

    /** Deletes the history, the workspace and the agent loop's session, then resets this object so nothing stale lingers. */
    async onJob({ job }: LifecycleJobContext): Promise<void> {
      if (job.fn !== RETIRE) return;
      await this.ctx.storage.deleteAll();
      this.ctx.abort("Retired after its retention period", { retryAlarm: false });
    }

    readonly history = (() => {
      const { sql } = this.ctx.storage;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS acp_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL)",
      );
      return {
        remember: (message: string) => {
          sql.exec("INSERT INTO acp_history (message) VALUES (?)", message);
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
      replay: (connection) => this.outbox.replay(connection, this.history.pages()),
      send: this.outbox.send,
      run: async (record, prompt, signal, emit) => {
        try {
          return await this.loop.run(record, prompt, signal, emit);
        } finally {
          // A turn can run on after its client is gone; the idle period starts when it ends.
          await this.touch();
        }
      },
    } satisfies SessionHost);

    /** session/new: creates this session and attaches the connection that made it. */
    async open(connection: ConnectionId, cwd: string): Promise<void> {
      this.session.open(connection, cwd);
      await this.touch();
    }

    /** One frame for this session; resolves once the frame is accepted, before a prompt's turn ends. */
    async receive(
      connection: ConnectionId,
      frame: JsonRpcRequest | JsonRpcNotification,
    ): Promise<void> {
      await this.touch();
      await Effect.runPromise(this.session.receive(connection, frame));
    }
  };
