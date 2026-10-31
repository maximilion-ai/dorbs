import type { Plugin } from "@opencode/plugin";
import {
  OpenCodeHarness,
  type OpenCodeHarnessOptions,
  type OpenCodeOperationResult,
  type OpenCodeSession,
  type OpenCodeSessionEvent,
} from "agents/harness/opencode";
import type { CapabilityStartContext } from "agents/lifecycle";

import { SYSTEM_PROMPT, type Loop, type LoopHost } from "./Loop.ts";
import { ModelUnavailable } from "./ModelProvider.ts";
import { fromLog, NOTHING_STREAMED, startsTurn, toOpenCodeUpdates } from "./openCodeUpdates.ts";
import { openCodeTools, OUTPUT_LIMITS, WORKSPACE_ROOT } from "./tools.ts";
import type { SessionRecord } from "./session.ts";
import { RunOutcome } from "./Turn.ts";

/** OpenCode's agent for a session: our system prompt, with OpenCode's own prompt sections after it. */
const AGENT = "dorbs";

const outcomeOf = ({ status, reason }: OpenCodeOperationResult): RunOutcome =>
  status === "done"
    ? RunOutcome.Answered()
    : reason === "interrupted"
      ? RunOutcome.Aborted()
      : RunOutcome.Failed({ reason: reason ?? "unanswered" });

/**
 * The session updates of the running turn already sent, by what makes them: a tool call's start or end, or a text or
 * reasoning part once it ended. Kept so a turn caught up after a restart sends none of them twice.
 */
const PUBLISHED_KEY = "opencode/published";
type Published = { readonly operationId: string; readonly keys: ReadonlyArray<string> };

const keyOf = (event: OpenCodeSessionEvent): string | undefined => {
  switch (event.type) {
    case "tool_start":
      return `start/${event.toolCallId}`;
    case "tool_end":
      return `end/${event.toolCallId}`;
    case "text_delta":
    case "text_end":
      return `text/${event.messageId}/${event.ordinal}`;
    case "reasoning_delta":
    case "reasoning_end":
      return `reasoning/${event.messageId}/${event.ordinal}`;
    default:
      return undefined;
  }
};

/** Sends what OpenCode's durable log has of the turn of `operationId`, from the input that started it. */
const catchUp = async (
  session: OpenCodeSession,
  operationId: string,
  send: (event: OpenCodeSessionEvent) => void,
) => {
  const names = new Map<string, string>();
  let inTurn = false;
  for await (const logged of session.log()) {
    inTurn ||= startsTurn(logged, operationId);
    const event = inTurn ? fromLog(names, logged) : undefined;
    if (event !== undefined) send(event);
  }
};

/** OpenCode's tables, under the prefix the harness gives them, once OpenCode has opened in this object. */
const opened = (storage: DurableObjectStorage): boolean =>
  storage.sql
    .exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name LIKE 'opencode\\_%' ESCAPE '\\' LIMIT 1",
    )
    .toArray().length > 0;

/**
 * Opens OpenCode at startup only where it has opened before, since only there can a turn be waiting to resume, so a
 * session/new does not boot it.
 */
class OpenCodeOnDemand extends OpenCodeHarness {
  readonly #storage: DurableObjectStorage;

  constructor(options: OpenCodeHarnessOptions, storage: DurableObjectStorage) {
    super(options);
    this.#storage = storage;
  }

  override async onStart(context: CapabilityStartContext): Promise<void> {
    if (opened(this.#storage)) await super.onStart(context);
  }
}

/** Our tools in place of every tool OpenCode would offer, its file, shell, web and subagent tools included. */
const toolsOnly = (tools: ReturnType<typeof openCodeTools>): Plugin.Plugin => ({
  id: "dorbs.tools",
  setup: async (ctx) => {
    const transform = await ctx.tool.transform((editor) => {
      for (const tool of editor.list()) editor.remove(tool.id);
      for (const tool of tools) editor.add(tool);
    });
    return () => transform.dispose();
  },
});

/**
 * OpenCode as a session's agent loop: an OpenCode session over this object's SQLite, made on the first prompt, with the
 * session's tools as its only tools and Code Mode off.
 */
export const makeOpenCodeLoop = (host: LoopHost): Loop => {
  // A write's diff, from the tool that made it to the event that reports it; both run in this isolate.
  const details = new Map<string, unknown>();
  const tools = openCodeTools(host.tools, (toolCallId, value) => details.set(toolCallId, value));

  const harness = new OpenCodeOnDemand(
    {
      opencode: async ({ storage }) => {
        const { openCode } = await host.models();
        if (openCode === undefined) {
          throw new ModelUnavailable({
            provider: "opencode",
            reason: "no OpenCode model is wired",
          });
        }
        await host.workspace.fs.mkdir(WORKSPACE_ROOT, { recursive: true });
        // Loaded on a session's first prompt, so an isolate that serves only Pi never evaluates OpenCode.
        const { OpenCodeWorkerd } = await import("@opencode/sdk/workerd");
        return OpenCodeWorkerd.create({
          storage,
          // The bundled model catalog has our model; a refresh would fetch models.opencode.ai on every open.
          models: { fetch: false },
          plugins: [...openCode.plugins, toolsOnly(tools)],
          config: {
            model: { providerID: openCode.model.providerID, model: openCode.model.id },
            default_agent: AGENT,
            agents: {
              [AGENT]: {
                mode: "primary",
                description: "Codes in the session's workspace.",
                system: SYSTEM_PROMPT,
              },
              // A title is a second model call per session that nothing shows.
              title: { disabled: true },
            },
            // Our tools hold their own guards; nothing waits on a permission prompt. Code Mode stays off.
            permissions: [
              { action: "*", resource: "*", effect: "allow" },
              { action: "execute", resource: "*", effect: "deny" },
            ],
            tool_output: { max_bytes: OUTPUT_LIMITS.maxBytes, max_lines: OUTPUT_LIMITS.maxLines },
            ...(openCode.providers === undefined ? {} : { providers: openCode.providers }),
          },
        });
      },
      defaults: { agent: AGENT },
    },
    host.storage,
  );

  // OpenCode serialises a session's inbox under a lock it keeps per isolate and keys by session id. Durable Objects
  // that share an isolate must not share an id, as they would with the harness's root session: one would resume the
  // other's waiting work in its own request, which workerd refuses.
  const openCodeSession = async (record: SessionRecord): Promise<string> => {
    if (record.openCodeSession !== undefined) return record.openCodeSession;
    const session = await harness.sessions.create();
    host.saveRecord({ ...record, openCodeSession: session.id });
    return session.id;
  };

  const run: Loop["run"] = async (record, prompt, operation, signal, emit) => {
    const session = harness.session(await openCodeSession(record));
    const settled = Promise.withResolvers<RunOutcome>();
    const stream = await session.events();
    let streamed = NOTHING_STREAMED;
    const take = (toolCallId: string) => {
      const value = details.get(toolCallId);
      details.delete(toolCallId);
      return value;
    };
    const kept = host.storage.kv.get<Published>(PUBLISHED_KEY);
    const published = new Set(kept?.operationId === operation.id ? kept.keys : []);
    const send = (event: OpenCodeSessionEvent) => {
      const key = keyOf(event);
      if (key !== undefined && published.has(key)) return;
      const [next, updates] = toOpenCodeUpdates(streamed, event, record.cwd, take);
      streamed = next;
      for (const update of updates) emit(update);
      if (key === undefined || event.type === "text_delta" || event.type === "reasoning_delta") {
        return;
      }
      published.add(key);
      host.storage.kv.put(PUBLISHED_KEY, { operationId: operation.id, keys: [...published] });
    };
    const abort = () => {
      session.abort().catch((error: unknown) => console.error("OpenCode abort failed", error));
    };
    signal.addEventListener("abort", abort);
    try {
      let known = false;
      if (operation.resumed) {
        // OpenCode resumes a turn a restart cut off while it boots, before this stream attached, and may even finish it.
        known = (await harness.pending({ session: session.id })).some(
          (pending) => pending.operationId === operation.id,
        );
        const ended = known ? undefined : await session.wait(operation.id);
        known ||= ended?.reason !== "not_found";
        if (known) await catchUp(session, operation.id, send);
        if (ended !== undefined && known) return outcomeOf(ended);
      }
      // The turn ends on the event that settles the submission, so every update of the run is sent before the reply.
      stream.start((events) => {
        for (const event of events) {
          send(event);
          if (event.type === "operation_end" && event.result.operationId === operation.id) {
            settled.resolve(outcomeOf(event.result));
          }
          if (event.type === "fault" && event.code === "events_failed") {
            settled.resolve(RunOutcome.Failed({ reason: `event stream failed: ${event.message}` }));
          }
        }
      });
      if (!known) {
        if (signal.aborted) return RunOutcome.Aborted();
        await session.submit(prompt, { operationId: operation.id });
      }
      if (signal.aborted) abort();
      return await settled.promise;
    } finally {
      signal.removeEventListener("abort", abort);
      await stream.stop();
      host.storage.kv.delete(PUBLISHED_KEY);
    }
  };

  // OpenCode sessions offer only the default model, so there is no other to move to.
  return { capability: harness, run, setModel: async () => {} };
};
