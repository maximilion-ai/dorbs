import { assert, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { CommitSha, RepoId } from "@dorbs/protocol/checker";
import { env } from "cloudflare:workers";
import * as Schema from "effect/Schema";

import { cloneRepo } from "../src/cloneRepo.ts";
import type { AcpSession } from "./worker.ts";

const ROOT = "/workspace";
const decodeRepo = Schema.decodeUnknownSync(RepoId);
const decodeCommit = Schema.decodeUnknownSync(CommitSha);

/** Sums the SQLite rows the session writes and reads, from the cursors workerd returns. */
const meter = (sql: SqlStorage) => {
  const cursors: Array<{ readonly rowsWritten: number; readonly rowsRead: number }> = [];
  const exec = sql.exec.bind(sql);
  Object.defineProperty(sql, "exec", {
    value: (query: string, ...bindings: unknown[]) => {
      const cursor = exec(query, ...bindings);
      cursors.push(cursor);
      return cursor;
    },
  });
  return () => {
    const rows = cursors.reduce(
      (sum, cursor) => ({
        written: sum.written + cursor.rowsWritten,
        read: sum.read + cursor.rowsRead,
      }),
      { written: 0, read: 0 },
    );
    cursors.length = 0;
    return rows;
  };
};

it("keeps a large repo out of the session's SQLite: clone, reads, grep and a commit each cost few rows", async () => {
  await runInDurableObject(
    env.AcpSession.getByName("cost"),
    async (instance: AcpSession, state) => {
      const rows = meter(state.storage.sql);
      const cloned = await cloneRepo(
        instance.fs,
        instance.toolHost.bases,
        { url: "http://git.test/large.git", headers: undefined },
        "test/large",
        ROOT,
        "cost",
      );
      instance.toolHost.saveClone({
        repo: decodeRepo("test/large"),
        commit: decodeCommit(cloned.commit),
        branch: cloned.branch,
        base: cloned.base,
      });
      const clone = rows();

      for (let at = 0; at < 50; at += 1)
        await instance.fs.readText(`${ROOT}/pkg${at % 20}/src/f${at}.ts`);
      const reads = rows();

      const matches = await instance.fs.grep(/value1999 =/u, ROOT, 10);
      const grep = rows();

      for (const at of [3, 4, 5])
        await instance.fs.writeFile(
          `${ROOT}/pkg${at}/src/f${at}.ts`,
          `export const changed = ${at};\n`,
        );
      const writes = rows();

      const { git } = await import("../src/git.ts");
      const context = {
        workspace: instance.workspace,
        fs: instance.fs,
        dir: ROOT,
        clone: {
          repo: decodeRepo("test/large"),
          commit: decodeCommit(cloned.commit),
          branch: cloned.branch,
          base: cloned.base,
        },
        created: () => {},
        url: undefined,
        headers: async () => undefined,
      };
      await git("checkout -b dorbs/cost", context);
      const added = await git("add pkg3/src/f3.ts pkg4/src/f4.ts pkg5/src/f5.ts", context);
      const committed = await git('commit -m "change three files"', context);
      const commit = rows();

      assert.deepStrictEqual(
        matches.map((match) => match.path),
        ["pkg19/src/f1999.ts"],
      );
      assert.strictEqual(added, "(no output)");
      assert.include(committed, "change three files");
      const measured = { clone, reads, grep, writes, commit };
      // Writing every file of this repo into the VFS cost 26,000 rows and every read about 900.
      assert.isBelow(clone.written, 300, JSON.stringify(measured));
      assert.isBelow(reads.read, 50 * 30, JSON.stringify(measured));
      assert.isBelow(grep.read, 500, JSON.stringify(measured));
      assert.isBelow(writes.written, 3 * 40, JSON.stringify(measured));
      // The commit writes the index, the three blobs, their trees up to the root, the commit and a ref.
      assert.isBelow(commit.written, 600, JSON.stringify(measured));
    },
  );
});
