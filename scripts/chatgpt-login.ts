// Signs the agent Worker's ChatGPT account in for MODEL_PROVIDER=chatgpt: Sign in with ChatGPT in the browser, then
// the credential goes to the Worker, which alone keeps and refreshes it. Only the installation id stays on disk.
//   AGENT_URL=https://<worker-host> AGENT_TOKEN="$(cat ~/.config/dorbs/agent-token)" pnpm chatgpt-login

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadlinePromises from "node:readline/promises";

import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const agentUrl = process.env.AGENT_URL;
const agentToken = process.env.AGENT_TOKEN;
if (agentUrl === undefined || agentToken === undefined) {
  console.log("not ok AGENT_URL and AGENT_TOKEN must be set");
  process.exit(1);
}

/** OpenAI wants one stable id per installation across logins. */
const DEVICE_ID = NodePath.join(NodeOS.homedir(), ".config/dorbs/chatgpt-device-id");
const deviceId = (): string => {
  if (NodeFS.existsSync(DEVICE_ID)) return NodeFS.readFileSync(DEVICE_ID, "utf8").trim();
  const id = NodeCrypto.randomUUID();
  NodeFS.mkdirSync(NodePath.dirname(DEVICE_ID), { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(DEVICE_ID, id, { mode: 0o600 });
  return id;
};

const oauth = openaiProvider().auth.oauth;
if (oauth === undefined) throw new Error("pi-ai's OpenAI provider has no OAuth");
const rl = NodeReadlinePromises.createInterface({ input: process.stdin, output: process.stdout });
const credential = await oauth
  .login(
    {
      signal: new AbortController().signal,
      // The flow asks for a pasted redirect URL only as a fallback, and aborts the question when the browser calls back.
      prompt: (question) =>
        rl.question(`${question.message} `, {
          signal: question.signal ?? new AbortController().signal,
        }),
      notify: (event) => {
        if (event.type === "auth_url") console.log(`Open ${event.url}`);
        else if (event.type === "info" || event.type === "progress") console.log(event.message);
      },
    },
    { getDeviceId: deviceId, agentName: "dorbs" },
  )
  .finally(() => rl.close());

const response = await fetch(new URL("/chatgpt/connect", agentUrl.replace(/^ws/u, "http")), {
  method: "POST",
  headers: { Authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
  body: JSON.stringify(credential),
});
if (response.status !== 204) {
  console.log(`not ok the Worker answered ${response.status}: ${await response.text()}`);
  process.exit(1);
}
console.log("ok the Worker's ChatGPT account is signed in");
