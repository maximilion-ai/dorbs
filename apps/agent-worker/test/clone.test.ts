import { assert, it, vi } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { CommitSha, RepoId } from "@dorbs/protocol/checker";
import { env } from "cloudflare:workers";
import * as Schema from "effect/Schema";

import type { LayeredFs } from "../src/layered.ts";
import type { AcpSession, RepoBase } from "./worker.ts";

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

it("deletes a base once no session has used it for 14 days, and keeps it while one does", async () => {
  const { cloneRepo } = await import("../src/cloneRepo.ts");
  const start = Date.UTC(2030, 0, 1);
  vi.useFakeTimers({ toFake: ["Date"], now: start });
  try {
    const prefix = await runInDurableObject(
      env.AcpSession.getByName("expiry"),
      async (instance: AcpSession) =>
        (
          await cloneRepo(
            instance.fs,
            instance.toolHost.bases,
            { url: "http://git.test/tree.git", headers: undefined },
            "test/expiry",
            ROOT,
            "expiry",
          )
        ).base,
    );
    const stored = async () => (await env.Bases.list({ prefix: `${prefix}/` })).objects.length;
    const repoBase = env.RepoBase.getByName(prefix);
    assert.isAbove(await stored(), 0);
    // Used this hour: the alarm puts deletion off.
    const alarm = () => runInDurableObject(repoBase, (instance: RepoBase) => instance.alarm());
    await alarm();
    assert.isAbove(await stored(), 0);
    vi.setSystemTime(start + 15 * 24 * 60 * 60 * 1000);
    await alarm();
    assert.strictEqual(await stored(), 0);
  } finally {
    vi.useRealTimers();
  }
});

type Session = { readonly fs: LayeredFs; readonly git: (line: string) => Promise<string> };

/** Runs `body` in a new session that cloned tree.git, with the agent's git tool. */
const withClone = (name: string, body: (session: Session) => Promise<void>) =>
  runInDurableObject(env.AcpSession.getByName(name), async (instance: AcpSession) => {
    // Loaded in the object, as the Worker loads them, not as a second copy in the test's module graph.
    const [{ cloneRepo }, { git }] = await Promise.all([
      import("../src/cloneRepo.ts"),
      import("../src/git.ts"),
    ]);
    const cloned = await cloneRepo(
      instance.fs,
      instance.toolHost.bases,
      { url: "http://git.test/tree.git", headers: undefined },
      "test/tree",
      ROOT,
      name,
    );
    const clone = {
      repo: decodeRepo("test/tree"),
      commit: decodeCommit(cloned.commit),
      branch: cloned.branch,
      base: cloned.base,
    };
    instance.toolHost.saveClone(clone);
    const context = {
      workspace: instance.workspace,
      fs: instance.fs,
      dir: ROOT,
      clone,
      created: () => {},
      url: undefined,
      headers: async () => undefined,
    };
    await body({ fs: instance.fs, git: (line) => git(line, context) });
  });

const codeOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? Reflect.get(error, "code") : error),
  );

it("keeps what a deleted directory held deleted when a file is written under it", async () => {
  await withClone("revive", async ({ fs }) => {
    await fs.promises.rm(`${ROOT}/d`, { recursive: true });
    await fs.writeFile(`${ROOT}/d/sub/b.ts`, "new\n");
    assert.deepStrictEqual(await fs.files(`${ROOT}/d`), ["d/sub/b.ts"]);
    assert.deepStrictEqual((await fs.changes()).deleted, [
      "d/a.ts",
      "d/sub/c.ts",
      "d/sub/deep/e.ts",
    ]);
    await fs.promises.rm(`${ROOT}/d`, { recursive: true });
    await fs.promises.mkdir(`${ROOT}/d`);
    assert.deepStrictEqual(await fs.promises.readdir(`${ROOT}/d`), []);
  });
});

it("follows links from either layer into the other, and stops at a loop", async () => {
  await withClone("links", async ({ fs }) => {
    assert.strictEqual(await fs.readText(`${ROOT}/skills/readme.md`), "readme\n");
    await fs.promises.symlink("file.txt", `${ROOT}/mine`);
    assert.strictEqual(await fs.readText(`${ROOT}/mine`), "file\n");
    await fs.promises.symlink("d/sub", `${ROOT}/sublink`);
    assert.deepStrictEqual(await fs.promises.readdir(`${ROOT}/sublink`), ["b.ts", "c.ts", "deep"]);
    await fs.writeFile(`${ROOT}/skills/new.md`, "x\n");
    assert.strictEqual(await fs.readText(`${ROOT}/docs/new.md`), "x\n");
    assert.strictEqual(await codeOf(fs.readText(`${ROOT}/loop`)), "ELOOP");
  });
});

it("puts no file under a file and no file over a directory", async () => {
  await withClone("enotdir", async ({ fs }) => {
    assert.strictEqual(await codeOf(fs.writeFile(`${ROOT}/file.txt/child`, "x")), "ENOTDIR");
    await fs.writeFile(`${ROOT}/mine.txt`, "x");
    assert.strictEqual(await codeOf(fs.promises.readdir(`${ROOT}/mine.txt`)), "ENOTDIR");
    assert.strictEqual(await codeOf(fs.writeFile(`${ROOT}/d`, "x")), "EISDIR");
    assert.deepStrictEqual((await fs.changes()).written, ["mine.txt"]);
  });
});

it("cuts a diff to the changed paths, whatever its pathspecs and revisions", async () => {
  await withClone("diff", async ({ fs, git }) => {
    await fs.writeFile(`${ROOT}/d/a.ts`, "changed\n");
    assert.strictEqual(await git("diff HEAD HEAD --"), "(no output)");
    assert.strictEqual(await git("diff -- docs"), "(no output)");
    assert.include(await git("diff d/a.ts"), "+changed");
    assert.include(await git("diff HEAD -- d"), "+changed");
  });
});

it("shows index-only changes, and rm without --cached deletes the file", async () => {
  await withClone("rm", async ({ fs, git }) => {
    assert.strictEqual(await git("rm --cached file.txt"), "rm 'file.txt'");
    assert.strictEqual(await git("status --short"), "D  file.txt\n ? file.txt");
    assert.strictEqual(await git("rm d/a.ts"), "rm 'd/a.ts'");
    assert.isUndefined(await fs.lstat(`${ROOT}/d/a.ts`));
    assert.strictEqual(
      await git("rm d/sub"),
      "fatal: not removing 'd/sub' recursively without -r\nexit 1",
    );
    assert.strictEqual(
      await git("rm -r d/sub"),
      "rm 'd/sub/b.ts'\nrm 'd/sub/c.ts'\nrm 'd/sub/deep/e.ts'",
    );
    assert.deepStrictEqual(await fs.files(`${ROOT}/d`), []);
  });
});

it("stages dotfiles", async () => {
  await withClone("dotfiles", async ({ fs, git }) => {
    await fs.writeFile(`${ROOT}/.github/workflows/ci.yml`, "on: pull_request\n");
    await fs.writeFile(`${ROOT}/.env.example`, "X=2\n");
    assert.strictEqual(await git("add .github ./.env.example"), "(no output)");
    assert.strictEqual(await git("status --short"), "M  .env.example\nM  .github/workflows/ci.yml");
  });
});

it("commits tracked changes alone with commit -a, deletions included", async () => {
  await withClone("commit-all", async ({ fs, git }) => {
    await fs.writeFile(`${ROOT}/file.txt`, "edited\n");
    await fs.writeFile(`${ROOT}/new.txt`, "new\n");
    await fs.promises.unlink(`${ROOT}/docs/readme.md`);
    assert.include(await git("commit -am edit"), "edit");
    assert.strictEqual(await git("status --short"), " ? new.txt");
  });
});

it("restores, checks out and moves paths", async () => {
  await withClone("restore", async ({ fs, git }) => {
    await fs.writeFile(`${ROOT}/d/a.ts`, "changed\n");
    assert.strictEqual(await git("restore d/a.ts"), "(no output)");
    assert.strictEqual(await fs.readText(`${ROOT}/d/a.ts`), "a\n");
    // Back to the base's file, so the overlay holds nothing for it.
    assert.deepStrictEqual((await fs.changes()).written, []);

    await fs.writeFile(`${ROOT}/d/a.ts`, "changed\n");
    await git("add d/a.ts");
    assert.strictEqual(await git("restore --staged d/a.ts"), "(no output)");
    assert.strictEqual(await git("status --short"), " M d/a.ts");
    assert.strictEqual(await git("checkout -- d"), "Updated 1 paths from the index");
    assert.strictEqual(await git("status"), "(no output)");

    await fs.writeFile(`${ROOT}/d/sub/b.ts`, "changed\n");
    await git("add d/sub/b.ts");
    assert.strictEqual(await git("checkout HEAD -- d/sub/b.ts"), "Updated 1 paths from the index");
    assert.strictEqual(await fs.readText(`${ROOT}/d/sub/b.ts`), "b\n");

    assert.strictEqual(await git("mv file.txt docs"), "(no output)");
    assert.strictEqual(await fs.readText(`${ROOT}/docs/file.txt`), "file\n");
    assert.strictEqual(await git("status --short"), "A  docs/file.txt\nD  file.txt");
  });
});
