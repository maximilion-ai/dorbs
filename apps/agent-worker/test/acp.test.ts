import { CommitSha, RepoId } from "@dorbs/protocol/typecheck";
import { assert, it, vi } from "@effect/vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { connect, open, updates } from "./client.ts";
import { gh } from "../src/gh.ts";
import * as GitHub from "../src/GitHub.ts";
import { COUNT, HELLO, LONG_ANSWER, NEW_FILE } from "../src/ScriptedModel.ts";
import type { AcpSession } from "./worker.ts";

// Captured from T3 Code 125b619: effect-acp's AcpClient.initialize with provider-acp's client capabilities.
const T3_INITIALIZE_LINE =
  '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":2,"info":{"name":"t3-code","version":"0.0.0"},"capabilities":{"elicitation":{"form":{}}},"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"elicitation":{"form":{}}},"clientInfo":{"name":"t3-code","version":"0.0.0"}},"id":1073741824,"traceId":"a895982fd0f222068500d20ac5e4f5e4","spanId":"2715004bf08acd5c","sampled":true}\n';

const prompt = (sessionId: string, text: string) => ({
  sessionId,
  prompt: [{ type: "text", text }],
});

const inSession = <R>(
  sessionId: string,
  fn: (instance: AcpSession, state: DurableObjectState) => R,
) =>
  runInDurableObject(env.AcpSession.getByName(sessionId), (instance: AcpSession, state) =>
    fn(instance, state),
  );

/** What the scripted model's "write hello" sends live, in order. */
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

const double = async <A>(url: string): Promise<A> => (await fetch(url)).json();

/** The typecheck double's request log and actions, from this point on. */
const recordSince = async () => {
  const [log, actions] = await Promise.all([
    double<string[]>("http://typecheck.test/__log"),
    double<unknown[]>("http://typecheck.test/__actions"),
  ]);
  return {
    log: async () => (await double<string[]>("http://typecheck.test/__log")).slice(log.length),
    actions: async () =>
      (await double<unknown[]>("http://typecheck.test/__actions")).slice(actions.length),
  };
};

const toolResult = (frames: ReturnType<typeof updates>, toolCallId: string) =>
  frames.find(
    (update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === toolCallId,
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

it("offers the deployment's one model in session/new, where T3 fills its model picker", async () => {
  const client = await connect();
  const response = await client.request(2, "session/new", { cwd: "/tmp/project", mcpServers: [] });
  assert.deepStrictEqual(response.result.configOptions, [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "scripted",
      options: [{ value: "scripted", name: "scripted" }],
    },
  ]);
});

it("creates a session without opening Pi", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  const piTables = await inSession(sessionId, (_instance, state) =>
    state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'pi_%'").toArray(),
  );
  assert.deepStrictEqual(piTables, []);
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

it("streams an answer Pi first shows mid-stream exactly once, start included", async () => {
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

it("uploads the blobs the typecheck service lacks and reports its diagnostics", async () => {
  const record = await recordSince();
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "typecheck"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  assert.deepStrictEqual(toolResult(updates(client.frames), "call-typecheck"), {
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
  const log = (await record.log()).filter((line) => !line.startsWith("git "));
  assert.deepStrictEqual(log, [
    "POST /actions",
    `PUT /blobs/${await sha256(COUNT)}`,
    "POST /actions",
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
          text: "<harness>\n[error] evil/repo is not a registered repo. Registered: test/fixture, test/github, test/elsewhere\n</harness>",
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
  await inSession(sessionId, (instance) => instance.workspace.fs.rm("/workspace/src/old.ts"));
  const record = await recordSince();
  const checked = await client.request(
    3,
    "session/prompt",
    prompt(sessionId, "change and typecheck"),
  );
  assert.deepStrictEqual(checked.result, { stopReason: "end_turn" });
  const action = {
    kind: "check",
    toolchain: "node26-tsrs0.20-oxlint1.89",
    repo: "test/fixture",
    commit,
    files: [
      { path: "src/index.ts", sha256: await sha256("export const greeting = 'hello';\n") },
      { path: "src/new.ts", sha256: await sha256(NEW_FILE) },
    ],
    deleted: ["src/old.ts"],
  };
  assert.deepStrictEqual(await record.actions(), [action, action], "MissingBlobs, then the retry");
  assert.deepStrictEqual(toolResult(updates(client.frames), "call-typecheck")?.content, [
    { type: "content", content: { type: "text", text: "No diagnostics." } },
  ]);
});

it("says so instead of calling the service when no repo is cloned", async () => {
  const record = await recordSince();
  const client = await connect();
  const sessionId = await client.newSession();
  const response = await client.request(2, "session/prompt", prompt(sessionId, "typecheck only"));
  assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  assert.deepStrictEqual(toolResult(updates(client.frames), "call-typecheck")?.content, [
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

it("replays a session's history in order to another connection that loads it, then answers", async () => {
  const first = await connect();
  const sessionId = await first.newSession();
  await first.request(2, "session/prompt", prompt(sessionId, "write hello"));
  const second = await connect();
  const { response, replay } = await second.load(1, sessionId);
  assert.deepStrictEqual(replay, [said("write hello"), ...WROTE_HELLO, ended("end_turn")]);
  assert.deepStrictEqual(second.frames.slice(replay.length), [
    { jsonrpc: "2.0", id: 1, result: {} },
  ]);
  assert.deepStrictEqual(response.result, {});
});

it("keeps the workspace and the Pi transcript for the connection that loads the session", async () => {
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
  assert.deepStrictEqual(twice.response, { jsonrpc: "2.0", id: 2, result: {} });
  const next = await second.request(3, "session/prompt", prompt(sessionId, "write hello"));
  assert.deepStrictEqual(next.result, { stopReason: "end_turn" });
});

it("runs a prompt on after its connection drops, and the next load replays how it ended", async () => {
  await double("http://typecheck.test/__hold");
  try {
    const first = await connect();
    const sessionId = await first.newSession();
    first.send({ id: 2, method: "session/prompt", params: prompt(sessionId, "typecheck") });
    await first.until((frame) => frame.params?.update?.toolCallId === "call-typecheck");
    await first.close(1000, "nc exited");
    const second = await connect();
    const attached = await second.load(1, sessionId);
    assert.deepStrictEqual(attached.replay.at(-1), {
      sessionUpdate: "tool_call",
      toolCallId: "call-typecheck",
      title: "`typecheck`",
      kind: "execute",
      status: "in_progress",
      rawInput: {},
    });
    await double("http://typecheck.test/__release");
    await second.until((frame) => frame.params?.update?.sessionUpdate === "session_info_update");
    const live = updates(second.frames.slice(attached.replay.length + 1));
    assert.deepStrictEqual(live, [
      {
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
    await double("http://typecheck.test/__release");
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

it("deletes a session's history, workspace and Pi session once it has been idle for 30 days", async () => {
  const start = Date.now();
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
        pi: state.storage.sql
          .exec<{ tables: number }>(
            "SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi_%'",
          )
          .one().tables,
      }));
    const before = await kept();
    assert.deepStrictEqual(
      [before.record, before.history > 0, before.workspace, before.pi > 0],
      [true, true, true, true],
    );

    // Thirty days after the first prompt, the second one ten days later still holds it.
    vi.setSystemTime(start + 39 * DAY_MS);
    await runDurableObjectAlarm(stub);
    assert.deepStrictEqual(await kept(), before);

    vi.setSystemTime(start + 40 * DAY_MS + 1);
    await runDurableObjectAlarm(stub).catch(() => "the object resets itself after deleting");
    assert.deepStrictEqual(await kept(), { record: false, history: 0, workspace: false, pi: 0 });
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
    .map((item: { content: { text: string } }) => item.content.text)
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

/** The App's two calls for a test/github token: find the installation, then mint for that repo alone. */
const MINT_GITHUB_TOKEN = [
  { method: "GET", path: "/repos/test/github/installation", body: null },
  {
    method: "POST",
    path: "/app/installations/1/access_tokens",
    body: {
      repositories: ["github"],
      permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "read",
        metadata: "read",
      },
    },
  },
];

it("clones, pushes and opens a pull request with one token the GitHub App mints for the repo alone", async () => {
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
  assert.deepStrictEqual(
    (await double<unknown[]>("http://github-api.test/__requests")).slice(requests),
    [
      ...MINT_GITHUB_TOKEN,
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

it("mints a fresh token for each call once the cached one is within five minutes of expiry", async () => {
  const requests = (await double<unknown[]>("http://github-api.test/__requests")).length;
  await double("http://github-api.test/__lifetime?seconds=240");
  try {
    const client = await connect();
    const sessionId = await client.newSession();
    const response = await client.request(2, "session/prompt", prompt(sessionId, "gh twice"));
    assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
    assert.deepStrictEqual(
      ["call-clone", "call-list", "call-list-again"].map(
        (id) => toolResult(updates(client.frames), id)?.status,
      ),
      ["completed", "completed", "completed"],
    );
  } finally {
    await double("http://github-api.test/__lifetime?seconds=3600");
  }
  const list = {
    method: "GET",
    path: "/repos/test/github/pulls?state=open&per_page=30",
    body: null,
  };
  assert.deepStrictEqual(
    (await double<unknown[]>("http://github-api.test/__requests")).slice(requests),
    [...MINT_GITHUB_TOKEN, ...MINT_GITHUB_TOKEN, list, ...MINT_GITHUB_TOKEN, list],
  );
});

it("says the GitHub App is not installed on a github.com repo it cannot reach", async () => {
  const client = await connect();
  const sessionId = await client.newSession();
  await client.request(2, "session/prompt", prompt(sessionId, "clone elsewhere"));
  const result = toolResult(updates(client.frames), "call-clone");
  assert.strictEqual(result?.status, "failed");
  assert.strictEqual(
    toolText(updates(client.frames), "call-clone"),
    "<harness>\n[error] The GitHub App is not installed on test/elsewhere. Install it on the repo to give dorbs access.\n</harness>",
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
      Effect.provide(GitHub.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    ),
);
