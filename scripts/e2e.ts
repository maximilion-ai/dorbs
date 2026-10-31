// Drives the local chain the way T3 Code does: nc -U -> acp-mux -> agent Worker (alchemy dev) -> checker double.

import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";

import {
  harness,
  muxConnectionsTo,
  ok,
  prompt,
  runMain,
  startStack,
  stopAll,
  TS_PROJECT,
  until,
  within,
} from "./stack.ts";

const CWD = "/tmp/dorbs-e2e-project";
const HELLO = 'export const n: number = "x";\n';
const HELLO_ERROR =
  "src/hello.ts:1:14 error TS2322 Type 'string' is not assignable to type 'number'. (tsc)";
const CHECK_OUTPUT = `typecheck failed (exit 2): pnpm run typecheck\n${HELLO_ERROR}\nlint passed: pnpm run lint`;
const PACKAGE_OUTPUT = `typecheck failed (exit 2): pnpm run typecheck\n${HELLO_ERROR}`;
const TEST_OUTPUT =
  "Tests passed: 1 passed, 0 failed, 0 skipped.\n$ pnpm exec vitest run src/hello.test.ts";
const REPO = "dorbs/e2e";

const run = async () => {
  const { double, commit, gitDir, workerPort, mux, startNc, stopNc } = await startStack({
    repo: REPO,
    harness: harness(),
    source: { fixture: TS_PROJECT },
    cwd: CWD,
    model: {
      provider: "scripted",
      id: "scripted",
      openrouterKey: "unused-by-the-scripted-model",
    },
  });

  const firstNc = await startNc();
  const { client } = firstNc;

  const created = await client.request(2, "session/new", { cwd: CWD, mcpServers: [] }, 15_000);
  const sessionId: unknown = created.result?.sessionId;
  NodeAssert.match(String(sessionId), /^[0-9a-f-]{36}$/u, JSON.stringify(created));
  if (typeof sessionId !== "string") throw new Error("unreachable");
  ok(`session/new returns sessionId ${sessionId}`);
  NodeAssert.equal(muxConnectionsTo(mux.proc.pid ?? 0, workerPort), 1);
  ok(`acp-mux holds one WebSocket to port ${workerPort}`);

  const first = await client.request(3, "session/prompt", prompt(sessionId, "e2e"), 120_000);
  const updates = client.updates(sessionId);
  const toolText = (toolCallId: string) =>
    updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === toolCallId)
      ?.content;
  NodeAssert.deepEqual(toolText("call-clone"), [
    {
      type: "content",
      content: {
        type: "text",
        text: `Cloned ${REPO} at ${commit} into the workspace root. Paths are relative to the repo root.`,
      },
    },
  ]);
  ok(`clone_repo cloned ${REPO} at ${commit} over HTTP`);
  const helloCall = updates.find(
    (u) => u.sessionUpdate === "tool_call" && u.toolCallId === "call-hello",
  );
  NodeAssert.deepEqual(
    { title: helloCall?.title, kind: helloCall?.kind, locations: helloCall?.locations },
    {
      title: "write_file src/hello.ts",
      kind: "edit",
      locations: [{ path: `${CWD}/src/hello.ts` }],
    },
  );
  ok("tool_call write_file src/hello.ts");
  const helloDone = updates.find(
    (u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call-hello",
  );
  NodeAssert.equal(helloDone?.status, "completed", JSON.stringify(helloDone));
  NodeAssert.deepEqual(
    helloDone.content.find((c: { type: string }) => c.type === "diff"),
    { type: "diff", path: `${CWD}/src/hello.ts`, newText: HELLO },
  );
  ok(`tool_call_update diff ${CWD}/src/hello.ts with newText ${JSON.stringify(HELLO)}`);
  const requests = double?.requests ?? [];
  NodeAssert.deepEqual(
    requests.map((request) => request.change.files.map((file) => file.path)),
    [
      ["src/hello.ts"],
      ["package.json", "src/hello.ts"],
      ["package.json", "src/hello.test.ts", "src/hello.ts"],
    ],
  );
  NodeAssert.deepEqual(requests[0]?.change, {
    files: [{ path: "src/hello.ts", content: HELLO }],
    deleted: [],
  });
  ok("each call carried only the files changed since the commit");
  NodeAssert.deepEqual(toolText("call-check"), [
    { type: "content", content: { type: "text", text: CHECK_OUTPUT } },
  ]);
  ok(`check tool_call_update: ${JSON.stringify(CHECK_OUTPUT)}`);
  NodeAssert.deepEqual(
    { only: requests[1]?.only, text: toolText("call-check-package") },
    {
      only: ["typecheck"],
      text: [{ type: "content", content: { type: "text", text: PACKAGE_OUTPUT } }],
    },
  );
  ok(
    "a package.json change goes to the checker, which keys a new environment on it, and only runs typecheck",
  );
  NodeAssert.deepEqual(
    { files: requests[2]?.files, text: toolText("call-test") },
    {
      files: ["src/hello.test.ts"],
      text: [{ type: "content", content: { type: "text", text: TEST_OUTPUT } }],
    },
  );
  ok(`test tool_call_update: ${JSON.stringify(TEST_OUTPUT)}`);
  const message = updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content.text)
    .join("");
  NodeAssert.equal(message, "n is a string.");
  ok(`agent_message_chunk ${JSON.stringify(message)}`);
  NodeAssert.deepEqual(first.result, { stopReason: "end_turn" }, JSON.stringify(first));
  ok("first prompt resolves with stopReason end_turn");

  const pushed = await client.request(4, "session/prompt", prompt(sessionId, "e2e push"), 60_000);
  NodeAssert.deepEqual(pushed.result, { stopReason: "end_turn" }, JSON.stringify(pushed));
  const pushText = client
    .updates(sessionId)
    .find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call-push")
    ?.content?.[0]?.content?.text;
  const remoteCommit = NodeChildProcess.execFileSync(
    "git",
    ["--git-dir", gitDir, "rev-parse", "refs/heads/dorbs/e2e"],
    { encoding: "utf8" },
  ).trim();
  NodeAssert.equal(pushText, `Pushed dorbs/e2e to origin at ${remoteCommit}`);
  NodeAssert.notEqual(remoteCommit, commit, "the pushed branch carries a new commit");
  ok(`git push -u origin dorbs/e2e put ${remoteCommit} on the local git server`);

  // T3 Code ends a thread's command by killing it, as on its 30-minute idle unload.
  firstNc.nc.kill("SIGTERM");
  await within(3_000, "nc to exit on SIGTERM", firstNc.exited);
  await until(5_000, "acp-mux to close its WebSocket", () =>
    muxConnectionsTo(mux.proc.pid ?? 0, workerPort) === 0 ? true : undefined,
  );
  ok("killed nc after the first turn; acp-mux closed its WebSocket");

  const secondNc = await startNc();
  const reloaded = secondNc.client;
  const load = { sessionId, cwd: CWD, mcpServers: [] };
  const loaded = await reloaded.request(2, "session/load", load, 15_000);
  NodeAssert.deepEqual(loaded.result, {}, JSON.stringify(loaded));
  const replayed = reloaded.frames
    .slice(0, reloaded.frames.indexOf(loaded))
    .filter((frame) => frame.method === "session/update" && frame.params?.sessionId === sessionId)
    .map((frame) => frame.params.update);
  NodeAssert.deepEqual(
    replayed.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call-hello")
      ?.content,
    helloDone.content,
    "the replay carries the first turn's diff of src/hello.ts",
  );
  NodeAssert.deepEqual(
    [replayed.at(0), replayed.at(-1)],
    [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "e2e" } },
      {
        sessionUpdate: "session_info_update",
        _meta: { "dorbs/turnEnded": { stopReason: "end_turn" } },
      },
    ],
  );
  NodeAssert.equal(
    replayed.length,
    client.updates(sessionId).length + 4,
    "the replay is both turns' updates, their prompts and their ends",
  );
  ok(
    `session/load on a new nc replays ${replayed.length} updates, the src/hello.ts diff included, then answers`,
  );

  const read = await reloaded.request(3, "session/prompt", prompt(sessionId, "read hello"), 30_000);
  NodeAssert.deepEqual(read.result, { stopReason: "end_turn" }, JSON.stringify(read));
  const readUpdates = reloaded.updates(sessionId).slice(replayed.length);
  NodeAssert.deepEqual(
    readUpdates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call-read")
      ?.content,
    [{ type: "content", content: { type: "text", text: HELLO } }],
  );
  ok(`a prompt on the loaded session reads src/hello.ts: ${JSON.stringify(HELLO)}`);
  NodeAssert.deepEqual(readUpdates.at(-1), {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Prompts so far: e2e | e2e push | read hello." },
  });
  ok("the model saw the first turn's prompt in the same transcript");

  const long = reloaded.request(4, "session/prompt", prompt(sessionId, "wait for cancel"), 30_000);
  await reloaded.next(
    (f) =>
      f.params?.update?.sessionUpdate === "tool_call_update" &&
      f.params.update.toolCallId === "call-list",
    30_000,
    "the long prompt to reach its model wait",
  );
  const cancelledAt = performance.now();
  reloaded.send({ method: "session/cancel", params: { sessionId } });
  const cancelled = await within(5_000, "cancelled prompt to resolve", long);
  const cancelMs = Math.round(performance.now() - cancelledAt);
  NodeAssert.deepEqual(cancelled.result, { stopReason: "cancelled" }, JSON.stringify(cancelled));
  ok(`session/cancel resolves the second prompt with cancelled in ${cancelMs} ms`);

  const third = await reloaded.request(5, "session/prompt", prompt(sessionId, "anything"), 30_000);
  NodeAssert.deepEqual(third.result, { stopReason: "end_turn" }, JSON.stringify(third));
  ok("third prompt after cancel resolves with end_turn");

  await stopNc(secondNc);

  const survivors = await stopAll();
  NodeAssert.deepEqual(survivors, [], "process groups that outlived SIGTERM");
  ok("every child process group exited");
};

await runMain(run);
