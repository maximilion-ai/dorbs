import { assert, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { connect, open, updates } from "./client.ts";
import { COUNT, HELLO } from "./ScriptedModel.ts";
import type { AcpConnection } from "./worker.ts";

// Captured from T3 Code 125b619: effect-acp's AcpClient.initialize with provider-acp's client capabilities.
const T3_INITIALIZE_LINE =
  '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":2,"info":{"name":"t3-code","version":"0.0.0"},"capabilities":{"elicitation":{"form":{}}},"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"elicitation":{"form":{}}},"clientInfo":{"name":"t3-code","version":"0.0.0"}},"id":1073741824,"traceId":"a895982fd0f222068500d20ac5e4f5e4","spanId":"2715004bf08acd5c","sampled":true}\n';

const prompt = (sessionId: string, text: string) => ({
  sessionId,
  prompt: [{ type: "text", text }],
});

const inObject = <R>(
  connection: string,
  fn: (instance: AcpConnection, state: DurableObjectState) => R,
) =>
  runInDurableObject(env.AcpConnection.getByName(connection), (instance: AcpConnection, state) =>
    fn(instance, state),
  );

const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

it("refuses a connection without the agent token", async () => {
  const missing = await open("/acp?connection=c1", { Upgrade: "websocket" });
  const wrong = await open("/acp?connection=c1", {
    Upgrade: "websocket",
    Authorization: "Bearer not-the-token",
  });
  assert.deepStrictEqual([missing.status, wrong.status], [401, 401]);
});

it("answers T3's initialize as an ACP v1 agent that advertises nothing beyond prompts", async () => {
  const client = await connect();
  client.sendLine(T3_INITIALIZE_LINE);
  const response = await client.until((frame) => frame.id === 1073741824);
  assert.deepStrictEqual(response, {
    jsonrpc: "2.0",
    id: 1073741824,
    result: {
      protocolVersion: 1,
      agentInfo: { name: "dorbs", version: "0.1.0" },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
    },
  });
});

it("creates a session without opening Pi", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  const piTables = await inObject(client.connection, (_instance, state) =>
    state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'pi_%'").toArray(),
  );
  assert.deepStrictEqual(piTables, []);
});

it("writes src/hello.ts and reports the write as a diff under the client cwd", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "write hello"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  assert.deepStrictEqual(updates(client.frames), [
    {
      sessionUpdate: "tool_call",
      toolCallId: "call-write",
      title: "write_file src/hello.ts",
      kind: "edit",
      status: "in_progress",
      locations: [{ path: "/Users/max/project/src/hello.ts" }],
      rawInput: { path: "src/hello.ts", content: HELLO },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-write",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "Created src/hello.ts" } },
        { type: "diff", path: "/Users/max/project/src/hello.ts", newText: HELLO },
      ],
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Wrote src/hello.ts." },
    },
  ]);
  const written = await inObject(client.connection, (instance) =>
    instance.workspace.fs.readFile("/workspace/src/hello.ts", "utf8"),
  );
  assert.strictEqual(written, HELLO);
});

it("uploads the blobs the typecheck service lacks and reports its diagnostics", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "typecheck"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  const result = updates(client.frames).find(
    (update) =>
      update.sessionUpdate === "tool_call_update" && update.toolCallId === "call-typecheck",
  );
  assert.deepStrictEqual(result, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-typecheck",
    status: "completed",
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: "src/count.ts:1:14 error TS2322 Type 'string' is not assignable to type 'number'. (tsrs)",
        },
      },
    ],
  });
  const log: string[] = await (await fetch("http://typecheck.test/__log")).json();
  const uploads = [
    `PUT /blobs/${await sha256("")}`,
    `PUT /blobs/${await sha256(COUNT)}`,
  ].toSorted();
  assert.deepStrictEqual(
    [log[0], ...log.slice(1, -1).toSorted(), log.at(-1)],
    ["POST /check", ...uploads, "POST /check"],
  );
});

it("resolves a cancelled prompt with cancelled and takes the next prompt", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  const cancelled = client.request(2, "session/prompt", prompt(sessionId, "wait for cancel"));
  await client.until((frame) => frame.params?.update?.sessionUpdate === "tool_call_update");
  client.send({ method: "session/cancel", params: { sessionId } });
  assert.deepStrictEqual((await cancelled).result, { stopReason: "cancelled" });
  const next = await client.request(3, "session/prompt", prompt(sessionId, "write hello"));
  assert.deepStrictEqual(next.result, { stopReason: "end_turn" });
});

it("rejects a second prompt while the first is running", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  const first = client.request(2, "session/prompt", prompt(sessionId, "wait for cancel"));
  await client.until((frame) => frame.params?.update?.sessionUpdate === "tool_call");
  const second = await client.request(3, "session/prompt", prompt(sessionId, "write hello"));
  assert.deepStrictEqual(second, {
    jsonrpc: "2.0",
    id: 3,
    error: { code: -32600, message: "Prompt 2 is still running in this session" },
  });
  client.send({ method: "session/cancel", params: { sessionId } });
  assert.deepStrictEqual((await first).result, { stopReason: "cancelled" });
});
