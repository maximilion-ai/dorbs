import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import type { Change } from "@dorbs/protocol/checker";
import { type CommitSha, RelativePath } from "@dorbs/protocol/typecheck";

import { runProcess } from "./runProcess.ts";

/** An environment's working tree: checked out from a repo's bare cache with an index of its own. */
export type Tree = {
  readonly gitDir: string;
  readonly workTree: string;
  /** The tree's index, outside the work tree, so nothing a check runs can touch it. */
  readonly indexFile: string;
};

export class UnsafePath extends Schema.TaggedError<UnsafePath>()("UnsafePath", {
  paths: Schema.Array(RelativePath),
}) {
  override get message(): string {
    return `These paths go through a symbolic link or replace a directory: ${this.paths.join(", ")}`;
  }
}

/** What an overlay changed, so `restore` can take it off again, also after a restart. */
export type Overlay = {
  readonly touched: ReadonlyArray<RelativePath>;
  /** Directories the overlay made for new files, deepest first. */
  readonly created: ReadonlyArray<string>;
};

const DIRTY = Schema.fromJsonString(
  Schema.Struct({ touched: Schema.Array(RelativePath), created: Schema.Array(Schema.String) }),
);
const decodeDirty = Schema.decodeUnknownOption(DIRTY);
const encodeDirty = Schema.encodeSync(DIRTY);

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

const git = Effect.fn("Tree.git")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  tree: Tree,
  args: ReadonlyArray<string>,
) {
  const result = yield* runProcess(
    spawner,
    tree.workTree,
    "git",
    ["--git-dir", tree.gitDir, "--work-tree", tree.workTree, ...args],
    { env: { ...GIT_ENV, GIT_INDEX_FILE: tree.indexFile }, timeout: "5 minutes" },
  ).pipe(Effect.orDie);
  if (result.exitCode !== 0) {
    return yield* Effect.die(
      new Error(`git ${args[0]} exited ${result.exitCode}: ${result.stderr}`),
    );
  }
  return result.stdout;
});

const lstat = (path: string) => Effect.promise(() => NodeFSP.lstat(path).catch(() => undefined));

const dirtyFile = (tree: Tree) => `${tree.indexFile}.dirty`;

export const make = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) => {
  /** Checks `commit` out into an empty work tree. */
  const materialize = Effect.fn("Tree.materialize")(function* (tree: Tree, commit: CommitSha) {
    yield* Effect.promise(() => NodeFSP.mkdir(tree.workTree, { recursive: true }));
    yield* git(spawner, tree, ["read-tree", "--reset", "-u", commit]);
  });

  /** Moves the tree from one commit to another, touching only the files that differ. */
  const moveTo = Effect.fn("Tree.moveTo")(function* (tree: Tree, from: CommitSha, to: CommitSha) {
    if (from === to) return;
    yield* git(spawner, tree, ["read-tree", "-m", "-u", from, to]).pipe(
      Effect.catchDefect(() => git(spawner, tree, ["read-tree", "--reset", "-u", to])),
    );
  });

  /** Takes an overlay off: tracked paths get the index's content back, new files and their directories go. */
  const restore = Effect.fn("Tree.restore")(function* (tree: Tree, overlay: Overlay) {
    if (overlay.touched.length > 0) {
      const tracked = (yield* git(spawner, tree, ["ls-files", "-z", "--", ...overlay.touched]))
        .split("\0")
        .filter((path) => path !== "");
      const trackedSet = new Set(tracked);
      if (tracked.length > 0)
        yield* git(spawner, tree, ["checkout-index", "-f", "-u", "-q", "--", ...tracked]);
      yield* Effect.promise(() =>
        Promise.all(
          overlay.touched
            .filter((path) => !trackedSet.has(path))
            .map((path) => NodeFSP.rm(NodePath.join(tree.workTree, path), { force: true })),
        ),
      );
    }
    for (const dir of overlay.created) {
      yield* Effect.promise(() =>
        NodeFSP.rmdir(NodePath.join(tree.workTree, dir)).catch(() => undefined),
      );
    }
    yield* Effect.promise(() => NodeFSP.rm(dirtyFile(tree), { force: true }));
  });

  /** Takes off an overlay a crash left on the tree. */
  const recover = Effect.fn("Tree.recover")(function* (tree: Tree) {
    const text = yield* Effect.promise(() =>
      NodeFSP.readFile(dirtyFile(tree), "utf8").catch(() => undefined),
    );
    if (text === undefined) return;
    const overlay = decodeDirty(text);
    if (overlay._tag === "Some") yield* restore(tree, overlay.value);
    else yield* Effect.promise(() => NodeFSP.rm(dirtyFile(tree), { force: true }));
  });

  /**
   * Writes a change into the tree in place. A path through a symbolic link of the tree is refused, so
   * no write leaves it; nothing else may run in the tree meanwhile.
   */
  const overlay = Effect.fn("Tree.overlay")(function* (tree: Tree, change: Change) {
    const unsafe: Array<RelativePath> = [];
    const created: Array<string> = [];
    for (const path of [...change.deleted, ...change.files.map((file) => file.path)]) {
      const names = path.split("/");
      for (let end = 1; end < names.length; end += 1) {
        const stat = yield* lstat(NodePath.join(tree.workTree, ...names.slice(0, end)));
        if (stat === undefined) break;
        if (!stat.isDirectory()) {
          unsafe.push(path);
          break;
        }
      }
      const final = yield* lstat(NodePath.join(tree.workTree, path));
      if (final?.isDirectory() === true) unsafe.push(path);
    }
    if (unsafe.length > 0) return yield* new UnsafePath({ paths: [...new Set(unsafe)] });
    const touched = [...change.deleted, ...change.files.map((file) => file.path)];
    for (const file of change.files) {
      for (
        let dir = NodePath.posix.dirname(file.path);
        dir !== ".";
        dir = NodePath.posix.dirname(dir)
      ) {
        if (
          (yield* lstat(NodePath.join(tree.workTree, dir))) === undefined &&
          !created.includes(dir)
        ) {
          created.push(dir);
        }
      }
    }
    created.sort((a, b) => b.split("/").length - a.split("/").length);
    const result: Overlay = { touched, created };
    yield* Effect.promise(() => NodeFSP.writeFile(dirtyFile(tree), encodeDirty(result)));
    yield* Effect.promise(async () => {
      await Promise.all(
        change.deleted.map((path) =>
          NodeFSP.rm(NodePath.join(tree.workTree, path), { force: true }),
        ),
      );
      await Promise.all(
        change.files.map(async (file) => {
          const target = NodePath.join(tree.workTree, file.path);
          await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
          // A symbolic link in the file's place is replaced, never followed.
          await NodeFSP.rm(target, { force: true });
          await NodeFSP.writeFile(target, file.content, { flag: "wx" });
        }),
      );
    });
    return result;
  });

  return { materialize, moveTo, overlay, restore, recover };
};
