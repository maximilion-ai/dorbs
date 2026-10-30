import { assert, it, vi } from "@effect/vitest";

import { makeOutbox } from "./Outbox.ts";
import { ConnectionId } from "./rpc.ts";

const A = ConnectionId.make("a");
const B = ConnectionId.make("b");

/** An outbox whose deliveries are logged and each held until the test releases it. */
const held = () => {
  const log: string[] = [];
  const releases: Array<() => void> = [];
  const outbox = makeOutbox(async (connection, messages) => {
    log.push(`${connection}:${messages.join(",")}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    releases.push(resolve);
    await promise;
  });
  const release = async (count: number) => {
    await vi.waitFor(() => assert.lengthOf(releases, count));
    releases[count - 1]?.();
  };
  return { log, outbox, release };
};

it("sends what queues during a delivery as one batch, one delivery at a time, in order", async () => {
  const { log, outbox, release } = held();
  outbox.send(A, "1");
  outbox.send(A, "2");
  await release(1);
  outbox.send(A, "3");
  outbox.send(A, "4");
  outbox.send(B, "5");
  outbox.send(A, "6");
  assert.deepStrictEqual(log, ["a:1,2"]);
  await release(2);
  await release(3);
  await release(4);
  assert.deepStrictEqual(log, ["a:1,2", "a:3,4", "b:5", "a:6"]);
});

it("replays page by page, reading the next page only once the last is delivered, before later sends", async () => {
  const { log, outbox, release } = held();
  function* pages() {
    for (const page of [["h1", "h2"], ["h3"]]) {
      log.push(`read ${page.join(",")}`);
      yield page;
    }
  }
  outbox.send(A, "1");
  outbox.replay(B, pages);
  outbox.send(B, "live");
  await release(1);
  await release(2);
  await release(3);
  await release(4);
  assert.deepStrictEqual(log, ["a:1", "read h1,h2", "b:h1,h2", "read h3", "b:h3", "b:live"]);
});

it("keeps sending after a delivery fails", async () => {
  const log: string[] = [];
  const outbox = makeOutbox(async (connection, messages) => {
    if (connection === A) throw new Error("gone");
    log.push(`${connection}:${messages.join(",")}`);
  });
  outbox.send(A, "1");
  outbox.replay(A, function* () {
    yield ["h1"];
  });
  outbox.send(B, "2");
  await vi.waitFor(() => assert.deepStrictEqual(log, ["b:2"]));
});
