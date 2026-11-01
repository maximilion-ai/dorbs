import { assert, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { CommitSha, RepoId } from "@dorbs/protocol/checker";
import { env } from "cloudflare:workers";
import * as Schema from "effect/Schema";

import type { AcpSession } from "./worker.ts";

const ROOT = "/workspace";
const decodeRepo = Schema.decodeUnknownSync(RepoId);
const decodeCommit = Schema.decodeUnknownSync(CommitSha);

it("clones into an overlay of git metadata over a shared base, and git status hashes no unchanged file", async () => {
  await runInDurableObject(env.AcpSession.getByName("clone-base"), async (instance: AcpSession) => {
    const { cloneRepo } = await import("../src/cloneRepo.ts");
    const cloned = await cloneRepo(
      instance.fs,
      instance.toolHost.bases,
      { url: "http://git.test/fixture.git", headers: undefined },
      "test/fixture",
      ROOT,
      "clone-base",
    );
    instance.toolHost.saveClone({
      repo: decodeRepo("test/fixture"),
      commit: decodeCommit(cloned.commit),
      branch: cloned.branch,
      base: cloned.base,
    });
    assert.strictEqual(
      await instance.workspace.git.revParse({ dir: ROOT, ref: "HEAD" }),
      cloned.commit,
    );
    // Every file reads through to the base; the overlay holds only git metadata.
    assert.deepStrictEqual((await instance.fs.changes()).written, []);
    assert.include(await instance.fs.readText(`${ROOT}/package.json`), "fixture");
    assert.deepStrictEqual(await instance.workspace.git.status({ dir: ROOT }), []);
    // isomorphic-git rewrites the index only when an entry's stats differ from the file's, after hashing it.
    assert.deepStrictEqual((await instance.fs.changes()).written, []);
  });
});

it("builds a base once and lets a second session reuse it", async () => {
  const { openBase, basePrefix } = await import("../src/base.ts");
  const clone = async (name: string) =>
    runInDurableObject(env.AcpSession.getByName(name), async (instance: AcpSession) => {
      const { cloneRepo } = await import("../src/cloneRepo.ts");
      return cloneRepo(
        instance.fs,
        instance.toolHost.bases,
        { url: "http://git.test/fixture.git", headers: undefined },
        "test/fixture",
        ROOT,
        name,
      );
    });
  const [first, second] = await Promise.all([clone("base-a"), clone("base-b")]);
  assert.strictEqual(first.base, second.base);
  assert.strictEqual(first.base, basePrefix("test/fixture", first.commit));
  const base = await openBase(env.Bases, first.base);
  assert.isDefined(base?.entry("package.json"));
});
