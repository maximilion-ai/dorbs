// Drives the local chain the way T3 Code does: nc -U -> acp-mux -> agent Worker (alchemy dev) -> typecheck service.

import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
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
const TYPECHECK_OUTPUT =
  "src/hello.ts:1:14 error TS2322 Type 'string' is not assignable to type 'number'. (tsrs)";
const REPO = "dorbs/e2e";

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

const run = async () => {
  const {
    typecheckPort,
    typecheckToken,
    dataDir,
    commit,
    gitDir,
    workerPort,
    mux,
    startNc,
    stopNc,
  } = await startStack({
    repo: REPO,
    fixture: TS_PROJECT,
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
  NodeAssert.deepEqual(
    NodeFS.readdirSync(NodePath.join(dataDir, "blobs")),
    [sha256(HELLO)],
    "the typecheck service received exactly the blob of src/hello.ts",
  );
  ok("the check carried only src/hello.ts, the one file changed since the commit");
  NodeAssert.deepEqual(toolText("call-typecheck"), [
    { type: "content", content: { type: "text", text: TYPECHECK_OUTPUT } },
  ]);
  ok(`typecheck tool_call_update from the real service: ${TYPECHECK_OUTPUT}`);
  const protectedOutput =
    `Not checked: package.json changed. The check takes dependencies and config from commit ${commit}, ` +
    "so dependency and config changes must be pushed first. Undo these changes to check the rest.";
  NodeAssert.deepEqual(toolText("call-typecheck-package"), [
    { type: "content", content: { type: "text", text: protectedOutput } },
  ]);
  ok("a package.json change gets the ProtectedPaths rejection text");
  const repeated = await fetch(`http://127.0.0.1:${typecheckPort}/actions`, {
    method: "POST",
    headers: { authorization: `Bearer ${typecheckToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "check",
      toolchain: "node26-tsrs0.20-oxlint1.89",
      repo: REPO,
      commit,
      files: [{ path: "src/hello.ts", sha256: sha256(HELLO) }],
      deleted: [],
    }),
  }).then((response) => response.json());
  NodeAssert.deepEqual(
    { tag: repeated._tag, cached: repeated.cached, outputs: repeated.outputs },
    { tag: "ActionResult", cached: true, outputs: [] },
    JSON.stringify(repeated),
  );
  NodeAssert.deepEqual(
    repeated.diagnostics.map(
      (d: { path: string; line: number; column: number; code: string; tool: string }) =>
        `${d.path}:${d.line}:${d.column} ${d.code} (${d.tool})`,
    ),
    ["src/hello.ts:1:14 TS2322 (tsrs)"],
  );
  ok("the agent's check, repeated as the same action, is served from the action cache");
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
  ok("the model saw the first turn's prompt in the same Pi transcript");

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
