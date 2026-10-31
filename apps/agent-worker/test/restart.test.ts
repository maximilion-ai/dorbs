// A turn survives its Durable Objects restarting under it; vitest.config.ts runs this file once per agent loop.
import { assert, beforeAll, it } from "@effect/vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { connect, updates, type Frame } from "./client.ts";
import { COUNT } from "../src/ScriptedModel.ts";
import { RESUMED } from "../src/session.ts";
import type { AcpSession } from "./worker.ts";

const prompt = (sessionId: string, text: string) => ({
  sessionId,
  prompt: [{ type: "text", text }],
});

const said = (text: string) => ({
  sessionUpdate: "user_message_chunk",
  content: { type: "text", text },
});

const ended = (stopReason: string) => ({
  sessionUpdate: "session_info_update",
  _meta: { "dorbs/turnEnded": { stopReason } },
});

const double = async <A>(url: string): Promise<A> => (await fetch(url)).json();

/** Each call gets a fresh stub, since a restarted object breaks the stubs that reached it. */
const inSession = <R>(
  sessionId: string,
  fn: (instance: AcpSession, state: DurableObjectState) => R,
) =>
  runInDurableObject(env.AcpSession.getByName(sessionId), (instance: AcpSession, state) =>
    fn(instance, state),
  );

/** Restarts an object as an eviction, a deploy or a crash does: its memory goes, its storage stays. */
const restart = async (stub: DurableObjectStub) => {
  const aborted = await runInDurableObject(stub, (_instance, state) =>
    state.abort("restarted"),
  ).catch((error: unknown) => String(error));
  assert.strictEqual(aborted, "Error: restarted");
};

/**
 * Restarts a session mid-turn, then fires the alarm that wakes it, which the loop's wake job keeps at most a heartbeat
 * (30 s) away while a turn runs. Resolves once the woken alarm returns, which waits out the turn.
 */
const restartSession = async (sessionId: string) => {
  await restart(env.AcpSession.getByName(sessionId));
  return { woken: runDurableObjectAlarm(env.AcpSession.getByName(sessionId)) };
};

const responses = (frames: ReadonlyArray<Frame>, id: number) =>
  frames.filter((frame) => frame.id === id && frame.method === undefined);

/** Every tool call in `updates` that has no end: an update after a restart that went missing. */
const unended = (updates: ReadonlyArray<any>) =>
  updates
    .filter((update) => update.sessionUpdate === "tool_call")
    .map((call) => call.toolCallId)
    .filter(
      (id) =>
        !updates.some(
          (update) =>
            update.sessionUpdate === "tool_call_update" &&
            update.toolCallId === id &&
            (update.status === "completed" || update.status === "failed"),
        ),
    );

const CHUNKS = new Set(["agent_message_chunk", "agent_thought_chunk"]);

/** The thread T3 shows: a run of chunks of one kind reads as one message. */
const thread = (updates: ReadonlyArray<any>) =>
  updates.reduce<any[]>((joined, update) => {
    const last = joined.at(-1);
    if (CHUNKS.has(update.sessionUpdate) && last?.sessionUpdate === update.sessionUpdate) {
      const text = `${last.content.text}${update.content.text}`;
      return [...joined.slice(0, -1), { ...last, content: { type: "text", text } }];
    }
    return [...joined, update];
  }, []);

// The tools import some modules on first use. The Worker bundle has them in memory, but the test runner fetches each
// over a connection, and a restart in the middle of that fetch leaves the import pending for good.
beforeAll(async () => {
  const client = await connect();
  await client.request(2, "session/prompt", prompt(await client.newSession(), "check"));
});

/** The prompts the session has yet to answer; once none is left, nothing can answer one again. */
const openPrompts = (sessionId: string) =>
  inSession(sessionId, (_instance, state) => state.storage.kv.get("acp/prompts"));

it("finishes a turn whose session restarted in the middle of a tool call", async () => {
  await double("http://checker.test/__hold");
  try {
    const client = await connect();
    const sessionId = await client.newSession();
    const turn = client.request(2, "session/prompt", prompt(sessionId, "check"));
    await client.until((frame) => frame.params?.update?.toolCallId === "call-check");
    const { woken } = await restartSession(sessionId);
    await double("http://checker.test/__release");

    assert.deepStrictEqual((await turn).result, { stopReason: "end_turn" });
    assert.isTrue(await woken);
    const live = updates(client.frames);
    assert.deepStrictEqual(unended(live), []);
    assert.deepStrictEqual(live.at(-1), {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "count is a string." },
    });
    // The load's answer comes after everything the session sent before it.
    const { replay } = await client.load(3, sessionId);
    assert.lengthOf(responses(client.frames, 2), 1, "one response to the prompt");
    assert.isUndefined(await openPrompts(sessionId));
    assert.deepStrictEqual(replay, [said("check"), ...live, ended("end_turn")]);
    assert.strictEqual(
      await inSession(sessionId, (instance) =>
        instance.workspace.fs.readFile("/workspace/src/count.ts", "utf8"),
      ),
      COUNT,
    );
  } finally {
    await double("http://checker.test/__release");
  }
});

it("finishes a turn whose session restarted in the middle of a model stream", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  const turn = client.request(2, "session/prompt", prompt(sessionId, "say slowly"));
  await client.until((frame) => frame.params?.update?.sessionUpdate === "agent_message_chunk");
  const { woken } = await restartSession(sessionId);

  assert.deepStrictEqual((await turn).result, { stopReason: "end_turn" });
  assert.isTrue(await woken);
  const live = updates(client.frames);
  assert.deepStrictEqual(unended(live), []);
  assert.deepStrictEqual(thread(live).at(-1), {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Cloned test/fixture and read its README." },
  });
  const loader = await connect();
  const { replay } = await loader.load(1, sessionId);
  assert.lengthOf(responses(client.frames, 2), 1, "one response to the prompt");
  assert.isUndefined(await openPrompts(sessionId));
  assert.deepStrictEqual(thread(replay), thread([said("say slowly"), ...live, ended("end_turn")]));
  assert.include(
    thread(live)
      .map((update) => update.content?.text)
      .join(""),
    RESUMED,
  );
  const next = await loader.request(2, "session/prompt", prompt(sessionId, "write hello"));
  assert.deepStrictEqual(next.result, { stopReason: "end_turn" });
});

it("shows a turn still running to a client that reconnects after its connection restarted, then runs its next prompt", async () => {
  await double("http://checker.test/__hold");
  try {
    const first = await connect();
    const sessionId = await first.newSession();
    first.send({ id: 2, method: "session/prompt", params: prompt(sessionId, "check") });
    await first.until((frame) => frame.params?.update?.toolCallId === "call-check");
    await restart(env.AcpConnection.getByName(first.connection));

    const second = await connect();
    const attached = await second.load(1, sessionId);
    assert.deepStrictEqual(attached.replay.at(-1)?.toolCallId, "call-check");
    // T3 sends the user's next prompt as soon as the load answers; it waits behind the running turn.
    const next = second.request(2, "session/prompt", prompt(sessionId, "write hello"));
    await double("http://checker.test/__release");

    assert.deepStrictEqual((await next).result, { stopReason: "end_turn" });
    const live = updates(second.frames.slice(attached.replay.length + 1));
    assert.deepStrictEqual(unended([...attached.replay, ...live]), []);
    const end = live.findIndex((update) => update.sessionUpdate === "session_info_update");
    assert.deepStrictEqual(live.slice(end - 1, end + 1), [
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "count is a string." },
      },
      ended("end_turn"),
    ]);
    assert.deepStrictEqual(live.slice(end + 1).at(-1), {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Wrote src/hello.ts." },
    });
    const { replay } = await second.load(3, sessionId);
    assert.lengthOf(responses(second.frames, 2), 1, "one response to the next prompt");
    assert.isUndefined(await openPrompts(sessionId));
    assert.deepStrictEqual(replay, [
      ...attached.replay,
      ...live.slice(0, end + 1),
      said("write hello"),
      ...live.slice(end + 1),
      ended("end_turn"),
    ]);
  } finally {
    await double("http://checker.test/__release");
  }
});

it("reloads a session idle past its eviction with a history longer than a replay page, and prompts it", async () => {
  const first = await connect();
  const sessionId = await first.newSession();
  const turns: unknown[] = [];
  for (let id = 2; turns.length <= 64; id += 1) {
    const from = updates(first.frames).length;
    await first.request(id, "session/prompt", prompt(sessionId, "write hello"));
    turns.push(said("write hello"), ...updates(first.frames).slice(from), ended("end_turn"));
  }
  await first.close(1000, "nc exited");
  await restart(env.AcpSession.getByName(sessionId));

  const second = await connect();
  const { replay } = await second.load(1, sessionId);
  assert.deepStrictEqual(replay, turns);
  const read = await second.request(2, "session/prompt", prompt(sessionId, "read hello"));
  assert.deepStrictEqual(read.result, { stopReason: "end_turn" });
  const prompts = turns.filter((update: any) => update.sessionUpdate === "user_message_chunk");
  assert.deepStrictEqual(updates(second.frames).at(-1), {
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: `Prompts so far: ${[...prompts.map(() => "write hello"), "read hello"].join(" | ")}.`,
    },
  });
});
