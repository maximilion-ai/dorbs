// What only the OpenCode loop has to show; vitest.config.ts runs this file with HARNESS=opencode.
import { assert, it, vi } from "@effect/vitest";
import { OpenCodeHarness } from "agents/harness/opencode";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Schema from "effect/Schema";

import { connect, updates } from "./client.ts";
import type { SessionRecord } from "../src/session.ts";
import type { AcpSession } from "./worker.ts";

const prompt = (sessionId: string, text: string) => ({
  sessionId,
  prompt: [{ type: "text", text }],
});

const double = async <A>(url: string): Promise<A> => (await fetch(url)).json();

/** Each call gets a fresh stub, since an evicted object breaks the stubs that reached it. */
const inSession = <R>(
  sessionId: string,
  fn: (instance: AcpSession, state: DurableObjectState) => R,
) =>
  runInDurableObject(env.AcpSession.getByName(sessionId), (instance: AcpSession, state) =>
    fn(instance, state),
  );

const decodeDurable = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.String,
    durable: Schema.optional(Schema.Struct({ seq: Schema.Number })),
  }),
);

/** OpenCode's durable events for the session, as `seq:type`. */
const durableLog = (sessionId: string) =>
  inSession(sessionId, async (instance, state) => {
    const harness = instance.loop.capability;
    if (!(harness instanceof OpenCodeHarness))
      throw new Error("The session does not run OpenCode.");
    const events: string[] = [];
    const { openCodeSession } = state.storage.kv.get<SessionRecord>("acp/session") ?? {};
    for await (const event of harness.session(openCodeSession).log()) {
      const durable = decodeDurable(event);
      if (durable.durable !== undefined) events.push(`${durable.durable.seq}:${durable.type}`);
    }
    return events;
  });

it("offers the model none of OpenCode's own tools, so none of them runs", async () => {
  const before = (await double<string[]>("http://checker.test/__log")).length;
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
    (await double<string[]>("http://checker.test/__log")).slice(before),
    [],
    "nothing reached the network",
  );
});

// Local workerd runs every Durable Object of a class in one isolate, as production may.
it("runs prompts of sessions that share an isolate at the same time", async () => {
  const answers = await Promise.all(
    Array.from({ length: 6 }, async () => {
      const client = await connect();
      const sessionId = await client.newSession();
      return (await client.request(2, "session/prompt", prompt(sessionId, "write hello"))).result;
    }),
  );
  assert.deepStrictEqual(
    answers,
    Array.from({ length: 6 }, () => ({ stopReason: "end_turn" })),
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
  await double("http://checker.test/__hold");
  try {
    const client = await connect();
    const sessionId = await client.newSession();
    const cancelled = client.request(2, "session/prompt", prompt(sessionId, "check"));
    await client.until((frame) => frame.params?.update?.toolCallId === "call-check");
    client.send({ method: "session/cancel", params: { sessionId } });
    assert.deepStrictEqual((await cancelled).result, { stopReason: "cancelled" });
    assert.deepStrictEqual(
      updates(client.frames).findLast((update) => update.toolCallId === "call-check"),
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-check",
        status: "failed",
        content: [
          { type: "content", content: { type: "text", text: "Tool execution interrupted" } },
        ],
      },
    );
    await double("http://checker.test/__release");
    const next = await client.request(3, "session/prompt", prompt(sessionId, "write hello"));
    assert.deepStrictEqual(next.result, { stopReason: "end_turn" });
  } finally {
    await double("http://checker.test/__release");
  }
});

it("catches up from OpenCode's durable log on a turn it ran on alone after a restart", async () => {
  await double("http://checker.test/__hold");
  try {
    const client = await connect();
    const sessionId = await client.newSession();
    const turn = client.request(2, "session/prompt", prompt(sessionId, "check"));
    await client.until((frame) => frame.params?.update?.toolCallId === "call-check");
    // OpenCode resumes the turn while it boots, before the session watches it; here it runs to the end unwatched.
    const restarted = await runInDurableObject(
      env.AcpSession.getByName(sessionId),
      async (_instance, state) => {
        state.storage.kv.put("test/prompts", state.storage.kv.get("acp/prompts"));
        state.storage.kv.delete("acp/prompts");
        await state.storage.sync();
        state.abort("restarted");
      },
    ).catch((error: unknown) => String(error));
    assert.strictEqual(restarted, "Error: restarted");
    await double("http://checker.test/__release");
    assert.isTrue(await runDurableObjectAlarm(env.AcpSession.getByName(sessionId)));
    await vi.waitFor(
      async () =>
        assert.match((await durableLog(sessionId)).at(-1) ?? "", /session\.execution\.succeeded$/),
      { timeout: 4000 },
    );
    const rejoined = await runInDurableObject(
      env.AcpSession.getByName(sessionId),
      async (_instance, state) => {
        state.storage.kv.put("acp/prompts", state.storage.kv.get("test/prompts"));
        await state.storage.sync();
        state.abort("restarted");
      },
    ).catch((error: unknown) => String(error));
    assert.strictEqual(rejoined, "Error: restarted");
    await inSession(sessionId, () => undefined);

    assert.deepStrictEqual((await turn).result, { stopReason: "end_turn" });
    const live = updates(client.frames);
    assert.deepStrictEqual(
      live.filter((update) => update.toolCallId === "call-check").map((update) => update.status),
      ["in_progress", "failed"],
    );
    assert.deepStrictEqual(live.at(-1), {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "count is a string." },
    });
    const { replay } = await client.load(3, sessionId);
    assert.deepStrictEqual(replay.slice(1, -1), live);
  } finally {
    await double("http://checker.test/__release");
  }
});
