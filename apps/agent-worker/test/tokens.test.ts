// Minting GitHub App tokens. Sessions share minted tokens through the GitHubTokens object, so these tests run in a project of their own, whose first
// test starts with no token cached, and the test that leaves a long-lived token cached runs last.
import { assert, beforeAll, it } from "@effect/vitest";

import {
  MINT_GITHUB_TOKEN,
  connect,
  double,
  isMint,
  prompt,
  toolResult,
  updates,
} from "./client.ts";

// The tools import some modules on first use, over the test runner's connection, which takes seconds. A clone of a
// repo the App is not installed on loads them and leaves no token cached.
beforeAll(async () => {
  const client = await connect();
  await client.request(2, "session/prompt", prompt(await client.newSession(), "clone elsewhere"));
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

it("mints one token for calls that need one at the same time", async () => {
  const requests = (await double<unknown[]>("http://github-api.test/__requests")).length;
  // Each token is due for refresh at once, so each call that finds none in flight mints.
  await double("http://github-api.test/__lifetime?seconds=240");
  try {
    const client = await connect();
    const sessionId = await client.newSession();
    const response = await client.request(2, "session/prompt", prompt(sessionId, "gh parallel"));
    assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  } finally {
    await double("http://github-api.test/__lifetime?seconds=3600");
  }
  const after = (await double<{ path: string }[]>("http://github-api.test/__requests")).slice(
    requests,
  );
  assert.deepStrictEqual(
    after.filter((request) => request.path.endsWith("/access_tokens")).length,
    2,
    "one token for the clone, one for both gh calls",
  );
});

it("reuses the token an earlier session minted for the repo", async () => {
  const clone = async () => {
    const client = await connect();
    const sessionId = await client.newSession();
    const response = await client.request(2, "session/prompt", prompt(sessionId, "clone github"));
    assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
  };
  await clone();
  const requests = (await double<unknown[]>("http://github-api.test/__requests")).length;
  await clone();
  const after = await double<{ path: string }[]>("http://github-api.test/__requests");
  assert.deepStrictEqual(after.slice(requests).filter(isMint), []);
});
