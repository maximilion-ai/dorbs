// What only the OpenCode loop has to show; vitest.config.ts runs this file with HARNESS=opencode.
import { assert, it } from "@effect/vitest";
import { OpenCodeHarness } from "agents/harness/opencode";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Schema from "effect/Schema";

import { connect, updates } from "./client.ts";
import type { AcpSession } from "./worker.ts";

const prompt = (sessionId: string, text: string) => ({
  sessionId,
  prompt: [{ type: "text", text }],
});

const double = async <A>(url: string): Promise<A> => (await fetch(url)).json();

/** Each call gets a fresh stub, since an evicted object breaks the stubs that reached it. */
const inSession = <R>(sessionId: string, fn: (instance: AcpSession) => R) =>
  runInDurableObject(env.AcpSession.getByName(sessionId), (instance: AcpSession) => fn(instance));

const decodeDurable = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.String,
    durable: Schema.optional(Schema.Struct({ seq: Schema.Number })),
  }),
);

/** OpenCode's durable events for the session, as `seq:type`. */
const durableLog = (sessionId: string) =>
  inSession(sessionId, async (instance) => {
    const harness = instance.loop.capability;
    if (!(harness instanceof OpenCodeHarness))
      throw new Error("The session does not run OpenCode.");
    const events: string[] = [];
    for await (const event of harness.session().log()) {
      const durable = decodeDurable(event);
      if (durable.durable !== undefined) events.push(`${durable.durable.seq}:${durable.type}`);
    }
    return events;
  });

it("offers the model none of OpenCode's own tools, so none of them runs", async () => {
  const before = (await double<string[]>("http://typecheck.test/__log")).length;
  const client = await connect();
  const sessionId = await client.newSession();
  await client.request(2, "session/prompt", prompt(sessionId, "clone github"));
  const config = await inSession(sessionId, (instance) =>
    instance.workspace.fs.readFile("/workspace/.git/config", "utf8"),
  );
  const response = await client.request(3, "session/prompt", prompt(sessionId, "opencode tools"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  const results = updates(client.frames).filter(
    (update) => update.sessionUpdate === "tool_call_update" && update.toolCallId !== "call-clone",
  );
  assert.deepStrictEqual(
    results.map((update) => [update.toolCallId, update.status, update.content[0].content.text]),
    ["shell", "bash", "write", "webfetch", "execute"].map((name) => [
      `call-${name}`,
      "failed",
      `No tool named "${name}" is currently available. Please use a tool from the available tool list.`,
    ]),
  );
  assert.strictEqual(
    await inSession(sessionId, (instance) =>
      instance.workspace.fs.readFile("/workspace/.git/config", "utf8"),
    ),
    config,
  );
  assert.deepStrictEqual(
    (await double<string[]>("http://typecheck.test/__log")).slice(before),
    [],
    "nothing reached the network",
  );
});

it("keeps OpenCode's durable event log and transcript across an eviction", async () => {
  const first = await connect();
  const sessionId = await first.newSession();
  await first.request(2, "session/prompt", prompt(sessionId, "write hello"));
  const log = await durableLog(sessionId);
  const { replay } = await (await connect()).load(1, sessionId);
  await inSession(sessionId, (instance) => {
    Object.assign(instance, { evicted: false });
  });

  const evicted = await runInDurableObject(
    env.AcpSession.getByName(sessionId),
    (_instance, state) => state.abort("evicted"),
  ).catch((error: unknown) => String(error));
  assert.strictEqual(evicted, "Error: evicted");
  assert.isFalse(await inSession(sessionId, (instance) => "evicted" in instance), "a new instance");

  assert.deepStrictEqual(
    log.map((event) => Number(event.split(":")[0])),
    log.map((_event, seq) => seq),
    "one event per sequence number, from 0",
  );
  assert.includeMembers(log, ["10:session.tool.success", "17:session.execution.succeeded"]);
  assert.deepStrictEqual(await durableLog(sessionId), log);
  const second = await connect();
  const reloaded = await second.load(1, sessionId);
  assert.deepStrictEqual(reloaded.replay, replay);
  const read = await second.request(2, "session/prompt", prompt(sessionId, "read hello"));
  assert.deepStrictEqual(read.result, { stopReason: "end_turn" });
  assert.deepStrictEqual(updates(second.frames).at(-1), {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Prompts so far: write hello | read hello." },
  });
});

it("cancels mid tool: the open call fails as interrupted and the session takes the next prompt", async () => {
  await double("http://typecheck.test/__hold");
  try {
    const client = await connect();
    const sessionId = await client.newSession();
    const cancelled = client.request(2, "session/prompt", prompt(sessionId, "typecheck"));
    await client.until((frame) => frame.params?.update?.toolCallId === "call-typecheck");
    client.send({ method: "session/cancel", params: { sessionId } });
    assert.deepStrictEqual((await cancelled).result, { stopReason: "cancelled" });
    assert.deepStrictEqual(
      updates(client.frames).findLast((update) => update.toolCallId === "call-typecheck"),
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-typecheck",
        status: "failed",
        content: [
          { type: "content", content: { type: "text", text: "Tool execution interrupted" } },
        ],
      },
    );
    await double("http://typecheck.test/__release");
    const next = await client.request(3, "session/prompt", prompt(sessionId, "write hello"));
    assert.deepStrictEqual(next.result, { stopReason: "end_turn" });
  } finally {
    await double("http://typecheck.test/__release");
  }
});
