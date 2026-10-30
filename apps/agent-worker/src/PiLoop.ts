import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";

import { SYSTEM_PROMPT, type Loop, type LoopHost } from "./Loop.ts";
import type { SessionRecord } from "./session.ts";
import { registerTools, WORKSPACE_ROOT } from "./tools.ts";
import { RunOutcome } from "./Turn.ts";
import { NOTHING_SENT, toSessionUpdates } from "./updates.ts";

const outcomeOf = (status: "done" | "unanswered", reason: string | undefined): RunOutcome =>
  status === "done"
    ? RunOutcome.Answered()
    : reason === "aborted"
      ? RunOutcome.Aborted()
      : RunOutcome.Failed({ reason: reason ?? "unanswered" });

/** Pi as a session's agent loop: a Pi session over this object's SQLite, made on the first prompt. */
export const makePiLoop = (host: LoopHost): Loop => {
  const registry = createRegistry();
  registry.install({
    name: "dorbs",
    tools: registerTools(host.tools),
    sections: [{ key: "agent", render: () => SYSTEM_PROMPT, tag: false }],
  });

  const harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      const { provider } = await host.models();
      const models = createModels();
      models.setProvider(provider);
      await host.workspace.fs.mkdir(WORKSPACE_ROOT, { recursive: true });
      return Harness.open(storage, { models, registry, onWake }, context);
    },
  });

  const piSession = async (record: SessionRecord): Promise<string> => {
    if (record.piSession !== undefined) return record.piSession;
    const { model } = await host.models();
    const session = await harness.sessions.create();
    await session.setModel(model);
    host.saveRecord({ ...record, piSession: session.id });
    return session.id;
  };

  const run: Loop["run"] = async (record, prompt, signal, emit) => {
    const pi = harness.session(await piSession(record));
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
    } finally {
      signal.removeEventListener("abort", abort);
      await stream.stop();
    }
  };

  return { capability: harness, run };
};
