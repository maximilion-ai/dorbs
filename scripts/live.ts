// Runs the local chain with a real model: DeepSeek v4.1 Flash on OpenRouter.
//   pnpm live            serve /tmp/dorbs-acp.sock for T3 Code's Local ACP provider until Ctrl-C
//   pnpm live "<prompt>" send one prompt through nc and print what T3 Code would show
// HARNESS=opencode runs the sessions on OpenCode instead of Pi.

import * as NodeFS from "node:fs";

import { harness, ok, prompt, runMain, startStack, TS_PROJECT } from "./stack.ts";

const SOCKET = "/tmp/dorbs-acp.sock";
const CWD = "/tmp/dorbs-live-project";
const REPO = "dorbs/live";
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
  const stack = await startStack({
    repo: REPO,
    harness: harness(),
    fixture: TS_PROJECT,
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
