import { CommitSha, RepoId } from "@dorbs/protocol/checker";
import { assert, it, vi } from "@effect/vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { connect, double, isMint, open, prompt, toolResult, updates } from "./client.ts";
import { gh } from "../src/gh.ts";
import * as GitHub from "../src/GitHub.ts";
import { FAILING_TEST, HELLO, LONG_ANSWER, NEW_FILE, PROXY_CONFIG } from "../src/ScriptedModel.ts";
import type { AcpSession } from "./worker.ts";

// Captured from T3 Code 125b619: effect-acp's AcpClient.initialize with provider-acp's client capabilities.
const T3_INITIALIZE_LINE =
  '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":2,"info":{"name":"t3-code","version":"0.0.0"},"capabilities":{"elicitation":{"form":{}}},"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"elicitation":{"form":{}}},"clientInfo":{"name":"t3-code","version":"0.0.0"}},"id":1073741824,"traceId":"a895982fd0f222068500d20ac5e4f5e4","spanId":"2715004bf08acd5c","sampled":true}\n';

/** This project's agent loop, which vitest.config.ts runs the suite under once each. */
const HARNESS = env.HARNESS;

/** A thrown tool error as the loop reports it: Pi wraps it for the model, OpenCode passes the message. */
const thrown = (message: string) =>
  HARNESS === "opencode" ? message : `<harness>\n[error] ${message}\n</harness>`;

/** How many tables the agent loop keeps in a session's SQLite. */
const loopTables = (state: DurableObjectState) =>
  state.storage.sql
    .exec<{ tables: number }>(
      "SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table' AND name LIKE ?",
      `${HARNESS}_%`,
    )
    .one().tables;

const inSession = <R>(
  sessionId: string,
  fn: (instance: AcpSession, state: DurableObjectState) => R,
) =>
  runInDurableObject(env.AcpSession.getByName(sessionId), (instance: AcpSession, state) =>
    fn(instance, state),
  );

/** What the scripted model's "write hello" sends live, in order. */
/** What the check tool shows for src/count.ts: the checker double's typecheck fails on it, its lint passes. */
const CHECK_OUTPUT =
  "typecheck failed (exit 2): pnpm run typecheck\n" +
  "src/count.ts:1:14 error TS2322 Type 'string' is not assignable to type 'number'. (tsc)\n" +
  "lint passed: pnpm run lint";

const WROTE_HELLO = [
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
];

const said = (text: string) => ({
  sessionUpdate: "user_message_chunk",
  content: { type: "text", text },
});

const ended = (stopReason: string) => ({
  sessionUpdate: "session_info_update",
  _meta: { "dorbs/turnEnded": { stopReason } },
});

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

/** The doubles' request log and the checker's requests, from this point on. */
const recordSince = async () => {
  const [log, requests] = await Promise.all([
    double<string[]>("http://checker.test/__log"),
    double<unknown[]>("http://checker.test/__requests"),
  ]);
  return {
    log: async () => (await double<string[]>("http://checker.test/__log")).slice(log.length),
    requests: async () =>
      (await double<unknown[]>("http://checker.test/__requests")).slice(requests.length),
  };
};

it("refuses a connection without the agent token", async () => {
  const missing = await open("/acp?connection=c1", { Upgrade: "websocket" });
  const wrong = await open("/acp?connection=c1", {
    Upgrade: "websocket",
    Authorization: "Bearer not-the-token",
  });
  assert.deepStrictEqual([missing.status, wrong.status], [401, 401]);
});

it("answers T3's initialize as an ACP v1 agent that advertises loadSession and nothing else", async () => {
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
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
    },
  });
});

it("sends each frame as a WebSocket message without a line terminator, which acp-mux appends", async () => {
  const client = await connect();
  client.sendLine(T3_INITIALIZE_LINE);
  await client.load(2, await client.newSession());
  assert.deepStrictEqual(
    client.messages.map((message) => message.slice(-1)),
    ["}", "}", "}"],
  );
});

/** The model picker session/new and session/load answer with: the deployment's one scripted model. */
const MODEL_OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "scripted:scripted",
    options: [{ value: "scripted:scripted", name: "scripted · scripted" }],
  },
];

it("offers the deployment's models in session/new, where T3 fills its model picker", async () => {
  const client = await connect();
  const response = await client.request(2, "session/new", { cwd: "/tmp/project", mcpServers: [] });
  assert.deepStrictEqual(response.result.configOptions, MODEL_OPTIONS);
});

it("creates a session without opening its agent loop", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  assert.strictEqual(await inSession(sessionId, (_instance, state) => loopTables(state)), 0);
});

it("writes src/hello.ts and reports the write as a diff under the client cwd", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "write hello"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  assert.deepStrictEqual(updates(client.frames), WROTE_HELLO);
  const written = await inSession(sessionId, (instance) =>
    instance.workspace.fs.readFile("/workspace/src/hello.ts", "utf8"),
  );
  assert.strictEqual(written, HELLO);
});

it("streams an answer the loop first shows mid-stream exactly once, start included", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "say slowly"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  const text = updates(client.frames)
    .filter((update) => update.sessionUpdate === "agent_message_chunk")
    .map((update) => update.content.text)
    .join("");
  assert.strictEqual(
    text,
    "I'll start by cloning the repo.Cloned test/fixture and read its README.",
  );
});

it("takes ./ paths and . for the workspace root, as models write them", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "list root"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  const listed = toolResult(updates(client.frames), "call-list-root");
  assert.deepStrictEqual(listed?.content, [
    { type: "content", content: { type: "text", text: "src/hello.ts" } },
  ]);
});

it("sends the change to the checker and reports its diagnostics", async () => {
  const record = await recordSince();
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "check"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  assert.deepStrictEqual(toolResult(updates(client.frames), "call-check"), {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-check",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: CHECK_OUTPUT } }],
  });
  // The check runs as a job: submitted once, then polled until it answers.
  const [submitted, ...polls] = (await record.log()).filter((line) => !line.startsWith("git "));
  assert.strictEqual(submitted, "POST /jobs/check");
  assert.isAbove(polls.length, 0);
  assert.isTrue(polls.every((line) => line === "GET /jobs/:id"));
});

it("runs only the checks the model names, and names the known ones for an unknown id", async () => {
  const record = await recordSince();
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "check typecheck"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  const frames = updates(client.frames);
  assert.deepStrictEqual(toolResult(frames, "call-check")?.content, [
    {
      type: "content",
      content: {
        type: "text",
        text: "Not checked: this repo has no check spelling. Its checks: typecheck, lint.",
      },
    },
  ]);
  assert.deepStrictEqual(toolResult(frames, "call-check-typecheck")?.content, [
    { type: "content", content: { type: "text", text: "typecheck passed: pnpm run typecheck" } },
  ]);
  assert.deepStrictEqual(
    frames.find((u) => u.sessionUpdate === "tool_call" && u.toolCallId === "call-check-typecheck")
      ?.title,
    "`check typecheck`",
  );
  assert.deepStrictEqual(
    (await record.requests()).map((request) =>
      typeof request === "object" && request !== null && "only" in request
        ? request.only
        : undefined,
    ),
    [["typecheck", "spelling"], ["typecheck"]],
  );
});

it("runs the tests the model names in the checker and reports their counts and failures", async () => {
  const commit = await double<string>("http://git.test/__commit");
  const record = await recordSince();
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "test"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  const frames = updates(client.frames);
  const call = frames.find((u) => u.sessionUpdate === "tool_call" && u.toolCallId === "call-test");
  assert.deepStrictEqual(
    { title: call?.title, kind: call?.kind },
    { title: "`test src/count.test.ts -t counts`", kind: "execute" },
  );
  assert.deepStrictEqual(toolResult(frames, "call-test")?.content, [
    {
      type: "content",
      content: {
        type: "text",
        text:
          "Tests failed (exit 1): 0 passed, 1 failed, 0 skipped.\n" +
          "$ pnpm exec vitest run src/count.test.ts\n" +
          "× src/count.test.ts\n" +
          "      Tests  1 failed | 0 passed (1)",
      },
    },
  ]);
  assert.deepStrictEqual(await record.requests(), [
    {
      repo: "test/fixture",
      commit,
      change: { files: [{ path: "src/count.test.ts", content: FAILING_TEST }], deleted: [] },
      files: ["src/count.test.ts"],
      filter: "counts",
    },
  ]);
});

it("refuses to clone a repo that is not registered", async () => {
  const record = await recordSince();
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(
    2,
    "session/prompt",
    prompt(sessionId, "clone unregistered"),
  );
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  assert.deepStrictEqual(toolResult(updates(client.frames), "call-clone"), {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-clone",
    status: "failed",
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: thrown(
            "evil/repo is not a registered repo. Registered: test/fixture, test/github, test/elsewhere",
          ),
        },
      },
    ],
  });
  assert.deepStrictEqual(await record.log(), []);
});

it("sends only the files changed since the cloned commit, and the deleted ones", async () => {
  const commit = await double<string>("http://git.test/__commit");
  const client = await connect();
  const sessionId = await client.newSession();
  const cloned = await client.request(2, "session/prompt", prompt(sessionId, "clone"));
  assert.deepStrictEqual(cloned.result, { stopReason: "end_turn" });
  assert.deepStrictEqual(toolResult(updates(client.frames), "call-clone")?.content, [
    {
      type: "content",
      content: {
        type: "text",
        text: `Cloned test/fixture at ${commit} into the workspace root. Paths are relative to the repo root.`,
      },
    },
  ]);
  // As a tool's change would, the deletion is recorded among the paths the agent touched.
  await inSession(sessionId, async (instance) => {
    await instance.workspace.fs.rm("/workspace/src/old.ts");
    instance.toolHost.touch(["src/old.ts"]);
  });
  const record = await recordSince();
  const checked = await client.request(3, "session/prompt", prompt(sessionId, "change and check"));
  assert.deepStrictEqual(checked.result, { stopReason: "end_turn" });
  assert.deepStrictEqual(await record.requests(), [
    {
      repo: "test/fixture",
      commit,
      change: {
        files: [
          { path: "src/index.ts", content: "export const greeting = 'hello';\n" },
          { path: "src/new.ts", content: NEW_FILE },
        ],
        deleted: ["src/old.ts"],
      },
    },
  ]);
  assert.deepStrictEqual(toolResult(updates(client.frames), "call-check")?.content, [
    {
      type: "content",
      content: {
        type: "text",
        text: "typecheck passed: pnpm run typecheck\nlint passed: pnpm run lint",
      },
    },
  ]);
});

it("says so instead of calling the service when no repo is cloned", async () => {
  const record = await recordSince();
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "check only"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  assert.deepStrictEqual(toolResult(updates(client.frames), "call-check")?.content, [
    {
      type: "content",
      content: {
        type: "text",
        text: "No repo is cloned, so there is nothing to check. Call clone_repo first.",
      },
    },
  ]);
  assert.deepStrictEqual(await record.log(), []);
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

it("runs a prompt sent while a turn runs once that turn ends, and answers each once", async () => {
  await double("http://checker.test/__hold");
  try {
    const client = await connect();
    const sessionId = await client.newSession();
    const first = client.request(2, "session/prompt", prompt(sessionId, "check"));
    await client.until((frame) => frame.params?.update?.toolCallId === "call-check");
    const second = client.request(3, "session/prompt", prompt(sessionId, "write hello"));
    await double("http://checker.test/__release");
    assert.deepStrictEqual(
      [(await first).result, (await second).result],
      [{ stopReason: "end_turn" }, { stopReason: "end_turn" }],
    );
    // The second turn starts once the first has answered, and each prompt is answered once.
    assert.deepStrictEqual(
      client.frames.flatMap((frame) => (frame.method === undefined ? [frame.id] : [])),
      [1, 2, 3],
    );
    const answered = client.frames.findIndex((frame) => frame.id === 2);
    assert.deepStrictEqual(updates(client.frames.slice(answered)), WROTE_HELLO);
  } finally {
    await double("http://checker.test/__release");
  }
});

it("answers a prompt waiting behind a cancelled turn as cancelled too", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  const first = client.request(2, "session/prompt", prompt(sessionId, "wait for cancel"));
  await client.until((frame) => frame.params?.update?.sessionUpdate === "tool_call");
  const second = client.request(3, "session/prompt", prompt(sessionId, "write hello"));
  client.send({ method: "session/cancel", params: { sessionId } });
  assert.deepStrictEqual(
    [(await first).result, (await second).result],
    [{ stopReason: "cancelled" }, { stopReason: "cancelled" }],
  );
  const next = await client.request(4, "session/prompt", prompt(sessionId, "write hello"));
  assert.deepStrictEqual(next.result, { stopReason: "end_turn" });
});

it("replays a session's history in order to another connection that loads it, then answers", async () => {
  const first = await connect();
  const sessionId = await first.newSession();
  await first.request(2, "session/prompt", prompt(sessionId, "write hello"));
  const second = await connect();
  const { response, replay } = await second.load(1, sessionId);
  assert.deepStrictEqual(replay, [said("write hello"), ...WROTE_HELLO, ended("end_turn")]);
  assert.deepStrictEqual(second.frames.slice(replay.length), [
    { jsonrpc: "2.0", id: 1, result: { configOptions: MODEL_OPTIONS } },
  ]);
  assert.deepStrictEqual(response.result, { configOptions: MODEL_OPTIONS });
});

it("keeps the workspace and the transcript for the connection that loads the session", async () => {
  const first = await connect();
  const sessionId = await first.newSession();
  await first.request(2, "session/prompt", prompt(sessionId, "write hello"));
  await first.close(1000, "nc exited");
  const second = await connect();
  await second.load(1, sessionId);
  const read = await second.request(2, "session/prompt", prompt(sessionId, "read hello"));
  assert.deepStrictEqual(read.result, { stopReason: "end_turn" });
  const live = updates(second.frames.slice(second.frames.findIndex((f) => f.id === 1) + 1));
  assert.deepStrictEqual(toolResult(live, "call-read")?.content, [
    { type: "content", content: { type: "text", text: HELLO } },
  ]);
  assert.deepStrictEqual(live.at(-1), {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Prompts so far: write hello | read hello." },
  });
});

it("answers a load of an unknown session with resource not found and replays nothing", async () => {
  const client = await connect();
  const unknown = crypto.randomUUID();
  const { response, replay } = await client.load(1, unknown);
  assert.deepStrictEqual(response, {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32002, message: `Unknown session ${unknown}` },
  });
  assert.deepStrictEqual(replay, []);
});

it("loads idempotently: a second load replays the same history and the session takes the next prompt", async () => {
  const first = await connect();
  const sessionId = await first.newSession();
  await first.request(2, "session/prompt", prompt(sessionId, "write hello"));
  const second = await connect();
  const once = await second.load(1, sessionId);
  const twice = await second.load(2, sessionId);
  assert.deepStrictEqual(
    [once.replay, twice.replay],
    [
      [said("write hello"), ...WROTE_HELLO, ended("end_turn")],
      [said("write hello"), ...WROTE_HELLO, ended("end_turn")],
    ],
  );
  assert.deepStrictEqual(twice.response, {
    jsonrpc: "2.0",
    id: 2,
    result: { configOptions: MODEL_OPTIONS },
  });
  const next = await second.request(3, "session/prompt", prompt(sessionId, "write hello"));
  assert.deepStrictEqual(next.result, { stopReason: "end_turn" });
});

it("runs a prompt on after its connection drops, and the next load replays how it ended", async () => {
  await double("http://checker.test/__hold");
  try {
    const first = await connect();
    const sessionId = await first.newSession();
    first.send({ id: 2, method: "session/prompt", params: prompt(sessionId, "check") });
    await first.until((frame) => frame.params?.update?.toolCallId === "call-check");
    await first.close(1000, "nc exited");
    const second = await connect();
    const attached = await second.load(1, sessionId);
    assert.deepStrictEqual(attached.replay.at(-1), {
      sessionUpdate: "tool_call",
      toolCallId: "call-check",
      title: "`check`",
      kind: "execute",
      status: "in_progress",
      rawInput: {},
    });
    await double("http://checker.test/__release");
    await second.until((frame) => frame.params?.update?.sessionUpdate === "session_info_update");
    const live = updates(second.frames.slice(attached.replay.length + 1));
    assert.deepStrictEqual(live, [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-check",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: CHECK_OUTPUT,
            },
          },
        ],
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "count is a string." },
      },
      ended("end_turn"),
    ]);
    const later = await second.load(3, sessionId);
    assert.deepStrictEqual(later.replay, [...attached.replay, ...live]);
    assert.deepStrictEqual(
      second.frames.filter((frame) => frame.id === 2),
      [],
      "the prompt's response belongs to the connection that sent it",
    );
  } finally {
    await double("http://checker.test/__release");
  }
});

it("keeps a long streamed turn as one history row per message and tool step, and replays the same thread", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "say at length"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  const live = updates(client.frames);
  const rows = await inSession(
    sessionId,
    (_instance, state) =>
      state.storage.sql.exec<{ rows: number }>("SELECT count(*) AS rows FROM acp_history").one()
        .rows,
  );
  const second = await connect();
  const { replay } = await second.load(1, sessionId);
  // The prompt; per step a thought, an answer, a tool call and its result; the closing answer; the end.
  assert.strictEqual(rows, 1 + 3 * 4 + 1 + 1);
  assert.deepStrictEqual(replay, thread([said("say at length"), ...live, ended("end_turn")]));
  assert.strictEqual(replay.at(-2)?.content?.text, LONG_ANSWER);
});

it("replays a history longer than one page of rows in order", async () => {
  const first = await connect();
  const sessionId = await first.newSession();
  const turns: unknown[] = [];
  for (let id = 2; turns.length < 70; id += 1) {
    const from = updates(first.frames).length;
    await first.request(id, "session/prompt", prompt(sessionId, "write hello"));
    turns.push(said("write hello"), ...updates(first.frames).slice(from), ended("end_turn"));
  }
  const second = await connect();
  const { replay } = await second.load(1, sessionId);
  assert.deepStrictEqual(replay, turns);
});

const DAY_MS = 24 * 60 * 60 * 1000;

it("deletes a session's history, workspace and agent loop session once it has been idle for 30 days", async () => {
  const start = Date.UTC(2030, 0, 1);
  vi.useFakeTimers({ toFake: ["Date"], now: start });
  try {
    const client = await connect();
    const sessionId = await client.newSession();
    await client.request(2, "session/prompt", prompt(sessionId, "write hello"));
    vi.setSystemTime(start + 10 * DAY_MS);
    await client.request(3, "session/prompt", prompt(sessionId, "read hello"));
    const stub = env.AcpSession.getByName(sessionId);
    const kept = () =>
      inSession(sessionId, async (instance, state) => ({
        record: state.storage.kv.get("acp/session") !== undefined,
        history: state.storage.sql
          .exec<{ rows: number }>("SELECT count(*) AS rows FROM acp_history")
          .one().rows,
        workspace: await instance.workspace.fs.readFile("/workspace/src/hello.ts", "utf8").then(
          () => true,
          () => false,
        ),
        loop: loopTables(state),
      }));
    const before = await kept();
    assert.deepStrictEqual(
      [before.record, before.history > 0, before.workspace, before.loop > 0],
      [true, true, true, true],
    );

    // Thirty days after the first prompt, the second one ten days later still holds it.
    vi.setSystemTime(start + 39 * DAY_MS);
    await runDurableObjectAlarm(stub);
    assert.deepStrictEqual(await kept(), before);

    vi.setSystemTime(start + 40 * DAY_MS + 1);
    await runDurableObjectAlarm(stub).catch(() => "the object resets itself after deleting");
    assert.deepStrictEqual(await kept(), { record: false, history: 0, workspace: false, loop: 0 });
    const { response } = await (await connect()).load(1, sessionId);
    assert.deepStrictEqual(response.error, {
      code: -32002,
      message: `Unknown session ${sessionId}`,
    });
  } finally {
    vi.useRealTimers();
  }
});

it("refuses a prompt from a connection the session moved away from", async () => {
  const first = await connect();
  const sessionId = await first.newSession();
  const second = await connect();
  await second.load(1, sessionId);
  const refused = await first.request(2, "session/prompt", prompt(sessionId, "write hello"));
  assert.deepStrictEqual(refused, {
    jsonrpc: "2.0",
    id: 2,
    error: {
      code: -32600,
      message: `Session ${sessionId} is attached to another connection. Send session/load to attach this one.`,
    },
  });
});

it("answers the client's close, so acp-mux can tear down both sides", async () => {
  const client = await connect();
  assert.strictEqual(await client.close(1000, "client hung up"), 1000);
});

const toolText = (frames: ReturnType<typeof updates>, toolCallId: string): string =>
  (toolResult(frames, toolCallId)?.content ?? [])
    .flatMap((item: { type: string; content: { text: string } }) =>
      item.type === "content" ? [item.content.text] : [],
    )
    .join("");

const refOf = (repo: string, ref: string) =>
  double<{ commit: string; files: Record<string, string> } | null>(
    `http://git.test/__ref?${new URLSearchParams({ repo, ref }).toString()}`,
  );

it("commits on a new branch and pushes it to origin, as git on a command line", async () => {
  const record = await recordSince();
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "git push"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  const pushed = await refOf("fixture.git", "refs/heads/dorbs/test");
  const commit = pushed?.commit ?? "";
  const frames = updates(client.frames);
  assert.deepStrictEqual(
    ["call-checkout", "call-add", "call-status", "call-commit", "call-push", "call-log"].map((id) =>
      toolText(frames, id),
    ),
    [
      "(no output)",
      "(no output)",
      // Computer 0.8.0 marks a file just added with git add -A as modified in the worktree too.
      "1 AM src/hello.ts",
      `[${commit.slice(0, 7)}] add hello`,
      `Pushed dorbs/test to origin at ${commit}`,
      `${commit.slice(0, 7)} add hello`,
    ],
  );
  assert.deepStrictEqual(toolResult(frames, "call-push")?.status, "completed");
  assert.deepStrictEqual(Object.keys(pushed?.files ?? {}).toSorted(), [
    "package.json",
    "src/hello.ts",
    "src/index.ts",
    "src/old.ts",
    "tsconfig.json",
  ]);
  assert.strictEqual(pushed?.files["src/hello.ts"], HELLO);
  assert.deepStrictEqual(
    (await record.log()).filter((line) => line.includes("with credentials")),
    [],
    "GitHub credentials go to github.com remotes only",
  );
});

it("refuses pushes to the base branch, force pushes, deletes, other remotes and shell operators", async () => {
  const before = await refOf("fixture.git", "refs/heads/main");
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "git refusals"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  const frames = updates(client.frames);
  const protectedText =
    "The base branch main is protected. Create a branch with git checkout -b <name>, commit, then push it.";
  assert.deepStrictEqual(
    [
      "call-push",
      "call-push-main",
      "call-push-heads",
      "call-push-tag",
      "call-force",
      "call-delete",
      "call-upstream",
      "call-pipe",
      "call-fetch",
      "call-global",
    ].map((id) => toolText(frames, id)),
    [
      protectedText,
      protectedText,
      protectedText,
      "Push to a branch name, such as git push origin HEAD:dorbs/my-change; refs/tags/v1 is not a branch.",
      "Force pushes are not allowed. Commit on top of the remote branch and push again.",
      "Deleting remote branches is not allowed.",
      "Only origin takes pushes. It is test/fixture, which the agent cloned; other remotes are not available.",
      "| is a shell operator. Run one command per call, with no shell operators.",
      "git fetch is not available: the agent manages the network and remotes. Commit your work, then publish it with git push.",
      "git runs in the repo root; global options such as -C are not supported. Pass the subcommand first.",
    ],
  );
  assert.deepStrictEqual(await refOf("fixture.git", "refs/heads/main"), before);
});

it("pushes only branches under dorbs/ that are new on origin or that the session created", async () => {
  const main = await refOf("fixture.git", "refs/heads/main");
  const owner = await connect();
  const ownerSession = await owner.newSession();
  await owner.request(2, "session/prompt", prompt(ownerSession, "push shared"));
  assert.strictEqual(
    toolText(updates(owner.frames), "call-push"),
    `Pushed dorbs/shared to origin at ${main?.commit}`,
  );

  const other = await connect();
  const otherSession = await other.newSession();
  await other.request(2, "session/prompt", prompt(otherSession, "push others"));
  assert.deepStrictEqual(
    ["call-push-taken", "call-push-release"].map((id) => toolText(updates(other.frames), id)),
    [
      "dorbs/shared already exists on origin, and this session did not create it. Push to a new branch, such as git push origin HEAD:dorbs/my-change.",
      "Push to a branch under dorbs/, such as git push origin HEAD:dorbs/my-change; release is not one.",
    ],
  );
  assert.strictEqual((await refOf("fixture.git", "refs/heads/dorbs/shared"))?.commit, main?.commit);
  assert.isNull(await refOf("fixture.git", "refs/heads/release"));

  await owner.request(3, "session/prompt", prompt(ownerSession, "push shared again"));
  const moved = await refOf("fixture.git", "refs/heads/dorbs/shared");
  assert.strictEqual(
    toolText(updates(owner.frames), "call-push-again"),
    `Pushed dorbs/shared to origin at ${moved?.commit}`,
  );
  assert.notStrictEqual(moved?.commit, main?.commit);
});

it("cuts each tool result to 64 KB and says how to read the rest", async () => {
  const lines = Array.from(
    { length: 3000 },
    (_, i) => `line ${String(i + 1).padStart(4, "0")} ${"x".repeat(30)}`,
  );
  const minified = "x".repeat(100_000);
  const client = await connect();
  const sessionId = await client.newSession();
  await client.request(2, "session/prompt", prompt(sessionId, "clone"));
  await inSession(sessionId, async (instance) => {
    await instance.workspace.fs.writeFile("/workspace/big.txt", `${lines.join("\n")}\n`);
    await instance.workspace.fs.writeFile("/workspace/src/index.ts", `${lines.join("\n")}\n`);
    await instance.workspace.fs.writeFile("/workspace/min.js", minified);
    instance.toolHost.touch(["big.txt", "src/index.ts", "min.js"]);
  });
  await client.request(3, "session/prompt", prompt(sessionId, "read big"));
  const frames = updates(client.frames);
  // 1585 lines of 41 bytes with their newlines fit in 64 KB, less 512 bytes kept for the note.
  assert.strictEqual(
    toolText(frames, "call-read"),
    `${lines.slice(0, 1585).join("\n")}\n[Showing lines 1-1585 of 3000. Call read_file with offset 1586 to read on.]`,
  );
  assert.strictEqual(
    toolText(frames, "call-read-range"),
    `${lines.slice(1499, 1501).join("\n")}\n[Showing lines 1500-1501 of 3000. Call read_file with offset 1502 to read on.]`,
  );
  assert.strictEqual(
    toolText(frames, "call-read-min"),
    `${minified.slice(0, 65_024)}\n[Line 1 is 100000 characters long; showing its first 65024. Search it with grep.]`,
  );
  assert.strictEqual(toolText(frames, "call-grep"), `min.js:1: ${"x".repeat(500)}…`);
  const diff = toolText(frames, "call-diff");
  assert.isAtMost(new TextEncoder().encode(diff).length, 64 * 1024);
  assert.match(
    diff,
    /\n\[Cut to its first \d+ of \d+ lines\. Narrow the command, such as git log -n 20 or git diff -- <path>\.\]$/u,
  );
});

it("remembers every branch a session creates, when it pushes several at once", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  await client.request(2, "session/prompt", prompt(sessionId, "push two"));
  const [a, b] = await Promise.all([
    refOf("fixture.git", "refs/heads/dorbs/pair-a"),
    refOf("fixture.git", "refs/heads/dorbs/pair-b"),
  ]);
  assert.deepStrictEqual(
    ["call-push-a-again", "call-push-b-again"].map((id) => toolText(updates(client.frames), id)),
    [
      `Pushed dorbs/pair-a to origin at ${a?.commit}`,
      `Pushed dorbs/pair-b to origin at ${b?.commit}`,
    ],
  );
});

it("refuses model writes to the clone's git directory, by any spelling or link, and git commands that rewrite it", async () => {
  const record = await recordSince();
  const client = await connect();
  const sessionId = await client.newSession();
  await client.request(2, "session/prompt", prompt(sessionId, "clone github"));
  const original = await inSession(sessionId, async (instance) => {
    await instance.workspace.fs.symlink(".git", "/workspace/meta");
    await instance.workspace.fs.symlink(".git/config", "/workspace/cfg");
    return instance.workspace.fs.readFile("/workspace/.git/config", "utf8");
  });
  const response = await client.request(3, "session/prompt", prompt(sessionId, "git metadata"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  const frames = updates(client.frames);
  const refused = (path: string) =>
    thrown(
      `${path} is in the repo's git directory, which only the agent writes. Change files with git commands instead.`,
    );
  const linked = (path: string) =>
    thrown(`${path} goes through a symbolic link. Write to the file it points to instead.`);
  assert.deepStrictEqual(
    [
      "call-write",
      "call-write-case",
      "call-edit",
      "call-write-link",
      "call-write-file-link",
      "call-config",
      "call-init",
      "call-rm-git",
    ].map((id) => toolText(frames, id)),
    [
      refused(".git/config"),
      refused("./.GIT/config"),
      refused(".git/config"),
      linked("meta/config"),
      linked("cfg"),
      "git config is not available: the agent manages the network and remotes. Commit your work, then publish it with git push.",
      "git init is not available: the agent manages the network and remotes. Commit your work, then publish it with git push.",
      "git does not take paths in the repo's git directory, such as .Git/config.\nexit 1",
    ],
  );
  const config = await inSession(sessionId, (instance) =>
    instance.workspace.fs.readFile("/workspace/.git/config", "utf8"),
  );
  assert.strictEqual(config, original);
  await client.request(4, "session/prompt", prompt(sessionId, "push github"));
  assert.deepStrictEqual(
    (await record.log()).filter((line) => line.startsWith("stray")),
    [],
  );
});

it("sends no credentials through a proxy the repo's git config names", async () => {
  const record = await recordSince();
  const client = await connect();
  const sessionId = await client.newSession();
  await client.request(2, "session/prompt", prompt(sessionId, "clone github"));
  await inSession(sessionId, async (instance) => {
    const config = await instance.workspace.fs.readFile("/workspace/.git/config", "utf8");
    await instance.workspace.fs.writeFile("/workspace/.git/config", `${config}\n${PROXY_CONFIG}`);
  });
  await client.request(3, "session/prompt", prompt(sessionId, "push proxied"));
  const frames = updates(client.frames);
  assert.strictEqual(
    toolText(frames, "call-push"),
    "Push refused: the repo's git config sets http.corsProxy, which would send origin's credentials to another host.\nexit 1",
  );
  assert.deepStrictEqual(
    (await record.log()).filter((line) => line.startsWith("stray")),
    [],
  );
  assert.isNull(await refOf("test/github.git", "refs/heads/dorbs/proxied"));
});

it("clones, pushes and opens a pull request with a token the GitHub App mints for the repo alone", async () => {
  const requests = (await double<unknown[]>("http://github-api.test/__requests")).length;
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "gh pr"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  const pushed = await refOf("test/github.git", "refs/heads/dorbs/pr");
  assert.strictEqual(pushed?.files["src/hello.ts"], HELLO);
  const frames = updates(client.frames);
  assert.deepStrictEqual(
    ["call-push", "call-pr-create", "call-pr-view", "call-pr-again", "call-pr-merge"].map((id) =>
      toolText(frames, id),
    ),
    [
      `Pushed dorbs/pr to origin at ${pushed?.commit}`,
      "https://github.com/test/github/pull/1",
      [
        "title:\tAdd hello",
        "state:\tOPEN",
        "number:\t1",
        "url:\thttps://github.com/test/github/pull/1",
        "--",
        "Adds src/hello.ts.",
      ].join("\n"),
      "HTTP 422: Validation Failed (A pull request already exists for test:dorbs/pr.)",
      [
        "gh pr merge 1 is not supported. Supported commands:",
        "gh pr create --title <title> --body <body> [--base <branch>] [--head <branch>] [--draft]",
        "gh pr view [<number>]",
        "gh pr list [--state open|closed|all]",
        "gh pr comment <number> --body <body>",
        "gh issue view <number>",
        "gh repo view",
      ].join("\n"),
    ],
  );
  // Whether the clone minted depends on the tokens earlier tests left; tokens.test.ts covers minting.
  assert.deepStrictEqual(
    (
      await double<{ method: string; path: string; body: unknown }[]>(
        "http://github-api.test/__requests",
      )
    )
      .slice(requests)
      .filter((request) => !isMint(request)),
    [
      {
        method: "POST",
        path: "/repos/test/github/pulls",
        body: {
          title: "Add hello",
          body: "Adds src/hello.ts.",
          head: "dorbs/pr",
          base: "main",
          draft: false,
        },
      },
      {
        method: "GET",
        path: "/repos/test/github/pulls?head=test%3Adorbs%2Fpr&state=open",
        body: null,
      },
      {
        method: "POST",
        path: "/repos/test/github/pulls",
        body: { title: "Again", body: "Again", head: "dorbs/pr", base: "main", draft: false },
      },
    ],
  );
  const config = await inSession(sessionId, (instance) =>
    instance.workspace.fs.readFile("/workspace/.git/config", "utf8"),
  );
  assert.include(config, "url = https://github.com/test/github.git");
  const tokens = await double<string[]>("http://github-api.test/__tokens");
  assert.isNotEmpty(tokens);
  for (const token of tokens) {
    assert.notInclude(config, token);
    assert.notInclude(JSON.stringify(client.frames), token);
  }
});

it("says the GitHub App is not installed on a github.com repo it cannot reach", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  await client.request(2, "session/prompt", prompt(sessionId, "clone elsewhere"));
  const result = toolResult(updates(client.frames), "call-clone");
  assert.strictEqual(result?.status, "failed");
  assert.strictEqual(
    toolText(updates(client.frames), "call-clone"),
    thrown(
      "The GitHub App is not installed on test/elsewhere. Install it on the repo to give dorbs access.",
    ),
  );
});

it("says gh is not configured for a repo that is not on github.com", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  await client.request(2, "session/prompt", prompt(sessionId, "gh off github"));
  assert.strictEqual(
    toolText(updates(client.frames), "call-gh"),
    "gh is not configured: test/fixture is not a github.com repo.",
  );
});

it.effect(
  "sends no credentials and says gh is not configured when the Worker has no GitHub App",
  () =>
    Effect.gen(function* () {
      const { api, headers } = yield* GitHub.GitHub;
      assert.isUndefined(
        yield* Effect.promise(() => headers("https://github.com/test/github.git")),
      );
      const said = yield* Effect.promise(() =>
        gh("pr view", {
          clone: {
            repo: RepoId.make("test/github"),
            commit: CommitSha.make("0".repeat(40)),
            branch: "main",
          },
          url: "https://github.com/test/github.git",
          api,
          currentBranch: async () => "dorbs/pr",
        }),
      );
      assert.strictEqual(said, "gh is not configured: the agent has no GitHub App.");
    }).pipe(
      Effect.provide(GitHub.layer()),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    ),
);
