import { assert, beforeAll, it } from "@effect/vitest";
import { env, exports } from "cloudflare:workers";

const signedIn = (expires: number) => ({
  type: "oauth" as const,
  access: "access-0",
  refresh: "refresh-0",
  expires,
  clientId: "client-1",
  scopes: ["chatgpt.tokens.use.direct"],
});

const refreshes = async (): Promise<string[]> =>
  (await fetch("http://auth.openai.com/__refreshes")).json();

// A refresh imports pi-ai's OAuth module on first use, over the test runner's connection, which takes seconds. An
// account of its own loads it, so the tests count only their own refreshes.
beforeAll(async () => {
  const account = env.ChatGptAccount.getByName("warm-up");
  await account.signIn(signedIn(0));
  await account.access();
});

it("refreshes an expiring token once for every session that asks meanwhile", async () => {
  const account = env.ChatGptAccount.getByName("refresh");
  await account.signIn(signedIn(0));
  const before = (await refreshes()).length;

  const tokens = await Promise.all(Array.from({ length: 8 }, () => account.access()));
  const again = await account.access();

  const sent = (await refreshes()).slice(before);
  assert.deepStrictEqual(sent, ["refresh-0"]);
  for (const token of [...tokens, again]) {
    assert.strictEqual(token?.access, `access-${before + 1}`);
    assert.strictEqual(token?.refresh, "");
  }
});

it("signs in through the Worker only with the agent token and a ChatGPT credential", async () => {
  const post = (body: unknown, token = "agent-token") =>
    exports.default.fetch("http://agent.test/chatgpt/connect", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  // 2100-01-01, so the account serves it as it is.
  const credential = signedIn(4_102_444_800_000);

  assert.strictEqual((await post(credential, "wrong")).status, 401);
  assert.strictEqual((await post({ ...credential, clientId: undefined })).status, 400);
  assert.strictEqual((await post(credential)).status, 204);
  const token = await env.ChatGptAccount.getByName("default").access();
  assert.strictEqual(token?.access, "access-0");
});
