// Runs the local chain with a real model: DeepSeek v4.1 Flash on OpenRouter.
//   pnpm live            serve /tmp/dorbs-acp.sock for T3 Code's Local ACP provider until Ctrl-C
//   pnpm live "<prompt>" send one prompt through nc and print what T3 Code would show
// HARNESS=opencode runs the sessions on OpenCode instead of Pi.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { harness, ok, prompt, runMain, startStack, TS_PROJECT } from "./stack.ts";

const SOCKET = "/tmp/dorbs-acp.sock";
const CWD = "/tmp/dorbs-live-project";
// CHECK_URL and CHECK_TOKEN point the Worker at a running checker instead of the local double.
// LIVE_REPO=owner/name registers that github.com repo instead of the fixture; a private one needs the
// GitHub App, whose id and key come from ~/.config/dorbs unless GITHUB_APP_ID is set.
const LIVE_REPO = process.env.LIVE_REPO;
const REPO = LIVE_REPO ?? "dorbs/live";
const CONFIG_DIR = NodePath.join(NodeOS.homedir(), ".config/dorbs");
const MODEL_ID = "deepseek/deepseek-v4.1-flash";

const openrouterKey = process.env.OPENROUTER_API_KEY;
if (openrouterKey === undefined || openrouterKey === "") {
  console.log("not ok OPENROUTER_API_KEY is not set");
  process.exit(1);
}

const describe = (update: any): string => {
  switch (update.sessionUpdate) {
    case "tool_call":
      return `tool_call ${update.title}`;
    case "tool_call_update": {
      const text = (update.content ?? [])
        .map((c: any) => (c.type === "diff" ? `diff ${c.path}` : (c.content?.text ?? "")))
        .join(" ")
        .slice(0, 300);
      return `tool_call_update ${update.toolCallId} ${update.status ?? ""} ${text}`.trim();
    }
    default:
      return update.sessionUpdate;
  }
};

type Stack = Awaited<ReturnType<typeof startStack>>;

const ask = async (stack: Stack, text: string) => {
  const session = await stack.startNc();
  const { client } = session;
  const created = await client.request(2, "session/new", { cwd: CWD, mcpServers: [] }, 15_000);
  const sessionId: string = created.result.sessionId;
  const startedAt = performance.now();
  const answer = await client.request(3, "session/prompt", prompt(sessionId, text), 300_000);
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  const updates = client.updates(sessionId);
  for (const update of updates.filter((u) => u.sessionUpdate !== "agent_message_chunk")) {
    console.log(`  ${describe(update)}`);
  }
  const reply = updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content.text)
    .join("");
  console.log(`reply: ${reply}`);
  ok(`prompt answered ${JSON.stringify(answer.result ?? answer.error)} in ${seconds} s`);
  await stack.stopNc(session);
};

await runMain(async () => {
  NodeFS.mkdirSync(CWD, { recursive: true });
  if (LIVE_REPO !== undefined && process.env.GITHUB_APP_ID === undefined) {
    // The Worker child inherits these; nothing prints them.
    process.env.GITHUB_APP_ID = NodeFS.readFileSync(
      NodePath.join(CONFIG_DIR, "github-app-id"),
      "utf8",
    ).trim();
    process.env.GITHUB_APP_PRIVATE_KEY = NodeFS.readFileSync(
      NodePath.join(CONFIG_DIR, "github-app.pkcs8.pem"),
      "utf8",
    );
  }
  const checkUrl = process.env.CHECK_URL;
  const checkToken = process.env.CHECK_TOKEN;
  const stack = await startStack({
    repo: REPO,
    harness: harness(),
    source:
      LIVE_REPO === undefined
        ? { fixture: TS_PROJECT }
        : { url: `https://github.com/${LIVE_REPO}` },
    ...(checkUrl === undefined || checkToken === undefined
      ? {}
      : { checker: { url: checkUrl, token: checkToken } }),
    cwd: CWD,
    socketPath: SOCKET,
    model: { provider: "openrouter", id: MODEL_ID, openrouterKey },
  });
  ok(`model ${MODEL_ID}; registered repo ${REPO}`);

  const text = process.argv[2];
  if (text === undefined) {
    ok(`T3 Local ACP command: /usr/bin/nc -U ${stack.socketPath} (Ctrl-C stops the stack)`);
    // Runs until SIGINT or SIGTERM, whose handlers in stack.ts tear the stack down.
    await new Promise<never>(() => {});
  } else {
    await ask(stack, text);
  }
});
