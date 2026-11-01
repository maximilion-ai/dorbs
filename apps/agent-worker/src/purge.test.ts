import { assert, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

it("leaves a purged session with no storage", async () => {
  const name = "purge-me";
  await runInDurableObject(env.AcpSession.getByName(name), async (_instance, state) => {
    state.storage.kv.put("workspace/clone", { repo: "test/fixture" });
  });
  await env.AcpSession.getByName(name)
    .purge()
    .catch(() => undefined);
  await runInDurableObject(env.AcpSession.getByName(name), async (_instance, state) => {
    assert.strictEqual(state.storage.kv.get("workspace/clone"), undefined);
    assert.strictEqual(await state.storage.getAlarm(), null);
  });
});
