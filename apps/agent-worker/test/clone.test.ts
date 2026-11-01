import { assert, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { shallowClone } from "../src/clone.ts";
import type { AcpSession } from "./worker.ts";

const ROOT = "/workspace";

it("clones into an index whose stats git status accepts, so it hashes no unchanged file", async () => {
  await runInDurableObject(
    env.AcpSession.getByName("clone-index"),
    async (instance: AcpSession) => {
      const { workspace } = instance;
      const cloned = await shallowClone(
        workspace,
        { url: "http://git.test/fixture.git", headers: undefined },
        ROOT,
      );
      assert.strictEqual(await workspace.git.revParse({ dir: ROOT, ref: "HEAD" }), cloned.commit);
      const before = await workspace.fs.readFile(`${ROOT}/.git/index`);
      const bytes = async (stream: ReadableStream<Uint8Array>) =>
        new Uint8Array(await new Response(stream).arrayBuffer());
      const indexBefore = await bytes(before);
      assert.deepStrictEqual(await workspace.git.status({ dir: ROOT }), []);
      // isomorphic-git rewrites the index when an entry's stats differ from the file's, after hashing the file.
      const indexAfter = await bytes(await workspace.fs.readFile(`${ROOT}/.git/index`));
      assert.deepStrictEqual([...indexAfter], [...indexBefore]);
    },
  );
});
