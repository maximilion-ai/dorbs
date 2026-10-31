import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  watchEvents,
  type AgentEventStream,
  type ConversationId,
  type SnapshotEvent,
} from "@earendil-works/pi-durable";
import { PiHarness, type PiModel } from "agents/harness/pi";

import { SYSTEM_PROMPT, type Loop, type LoopHost } from "./Loop.ts";
import { modelOf } from "./ModelProvider.ts";
import type { SessionRecord } from "./session.ts";
import { registerTools, WORKSPACE_ROOT } from "./tools.ts";
import { RunOutcome } from "./Turn.ts";
import { NOTHING_SENT, toSessionUpdates, type Sent } from "./updates.ts";

/** How a run ended; a failure carries pi's detail, such as the provider's error behind `model_error`. */
const outcomeOf = (
  status: "done" | "unanswered",
  reason: string | undefined,
  detail?: unknown,
): RunOutcome =>
  status === "done"
    ? RunOutcome.Answered()
    : reason === "aborted"
      ? RunOutcome.Aborted()
      : RunOutcome.Failed({
          reason: `${reason ?? "unanswered"}${typeof detail === "string" && detail !== "" ? `: ${detail}` : ""}`,
        });

/** A Pi session id is its conversation id in decimal, as agents' PiHarness maps them. */
const isConversationId = (id: number): id is ConversationId => Number.isSafeInteger(id) && id >= 1;

/** The message a restart cut off mid-stream was sent as far as Pi had committed it. */
const sentOf = ({ generation }: SnapshotEvent): Sent =>
  new Map(
    (generation?.message?.content ?? []).flatMap((block, index): [number, number][] =>
      block.type === "text"
        ? [[index, block.text.length]]
        : block.type === "thinking"
          ? [[index, block.thinking.length]]
          : [],
    ),
  );

/** Pi as a session's agent loop: a Pi session over this object's SQLite, made on the first prompt. */
export const makePiLoop = (host: LoopHost): Loop => {
  const registry = createRegistry();
  registry.install({
    name: "dorbs",
    tools: registerTools(host.tools),
    sections: [{ key: "agent", render: () => SYSTEM_PROMPT, tag: false }],
  });

  /** The events of a turn a restart cut off, watched from before Pi resumes its tasks, so none goes unsent. */
  let rejoined: { readonly operationId: string; readonly stream: AgentEventStream } | undefined;

  const harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      const { providers, env, credentials } = await host.models();
      const models = createModels({
        authContext: { env: async (name) => env?.[name], fileExists: async () => false },
        ...(credentials === undefined ? {} : { credentials }),
      });
      for (const provider of providers) models.setProvider(provider);
      await host.workspace.fs.mkdir(WORKSPACE_ROOT, { recursive: true });
      const pi = await Harness.open(storage, { models, registry, onWake }, context);
      // PiHarness resumes Pi's tasks once this returns.
      const operationId = host.rejoining();
      const conversation = Number(host.record()?.piSession);
      if (operationId !== undefined && isConversationId(conversation)) {
        rejoined = { operationId, stream: await watchEvents(pi, conversation, context) };
      }
      return pi;
    },
  });

  /** The model the session picked, which every listed provider was registered for when Pi opened. */
  const picked = async (record: SessionRecord): Promise<PiModel> => {
    const model = modelOf(await host.models(), record.model);
    if (model === undefined) throw new Error("No model is configured");
    return model;
  };

  const piSession = async (record: SessionRecord): Promise<string> => {
    if (record.piSession !== undefined) return record.piSession;
    const model = await picked(record);
    const session = await harness.sessions.create();
    await session.setModel(model);
    host.saveRecord({ ...record, piSession: session.id });
    return session.id;
  };

  const run: Loop["run"] = async (record, prompt, operation, signal, emit) => {
    const operationId = operation.id;
    const session = await piSession(record);
    const pi = harness.session(session);
    // Opening Pi watches a turn a restart cut off.
    await harness.pi();
    const early = rejoined?.operationId === operationId ? rejoined.stream : undefined;
    rejoined = undefined;
    const stream = early ?? (await pi.events());
    const settled = Promise.withResolvers<RunOutcome>();
    let sent = early === undefined ? NOTHING_SENT : sentOf(early.snapshot);
    // The turn ends on the event that settles the submission, so every update of the run is sent before the reply.
    stream.start(async (events) => {
      for (const event of events) {
        const [next, updates] = toSessionUpdates(sent, event, record.cwd);
        sent = next;
        for (const update of updates) emit(update);
        if (event.type === "submission" && event.record.requestId === operationId) {
          const { status } = event.record;
          if (status === "done" || status === "unanswered") {
            settled.resolve(outcomeOf(status, event.record.reason, event.record.detail));
          }
        }
      }
    });
    const abort = () => {
      pi.abort().catch((error: unknown) => console.error("Pi abort failed", error));
    };
    signal.addEventListener("abort", abort);
    try {
      const pending = operation.resumed
        ? (await harness.pending({ session })).find((known) => known.operationId === operationId)
        : undefined;
      if (pending === undefined) {
        if (operation.resumed) {
          // Pi may have settled the operation before the restart, or never got it.
          const { status, reason } = await pi.wait(operationId);
          if (reason !== "not_found") return outcomeOf(status, reason);
        }
        if (signal.aborted) return RunOutcome.Aborted();
        await pi.submit(prompt, { operationId, whenBusy: "reject" });
      }
      if (signal.aborted) abort();
      if (pending?.status === "parked") {
        // Pi stops running work that restarts keep cutting off; the turn ends instead of waiting on it.
        await pi.abort();
        await settled.promise;
        return RunOutcome.Failed({
          reason: "The turn was cut off by too many restarts and was stopped.",
        });
      }
      return await Promise.race([
        settled.promise,
        stream.closed.then((end) => RunOutcome.Failed({ reason: `event stream ${end.reason}` })),
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
      await stream.stop();
    }
  };

  const setModel: Loop["setModel"] = async (record) => {
    if (record.piSession === undefined) return;
    await harness.session(record.piSession).setModel(await picked(record));
  };

  return { capability: harness, run, setModel };
};
