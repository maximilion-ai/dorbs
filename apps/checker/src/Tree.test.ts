import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { CommitSha, RelativePath } from "@dorbs/protocol/typecheck";

import { makeRepo } from "../../../scripts/gitFixture.ts";
import * as Tree from "./Tree.ts";

const GIT_ENV = {
  PATH: process.env["PATH"] ?? "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const FILES = {
  "package.json": "{}\n",
  "src/a.ts": "export const a = 1;\n",
  "src/old.ts": "export const old = 1;\n",
  link: { symlink: "/etc" },
  "src/self": { symlink: "a.ts" },
};

/** A bare repo with FILES at its first commit and a second commit that changes and drops a file. */
const fixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checker-tree-"));
  const gitDir = NodePath.join(root, "repo.git");
  const first = CommitSha.make(makeRepo(gitDir, FILES));
  const work = NodePath.join(root, "next");
  const run = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", ["--git-dir", gitDir, "--work-tree", work, ...args], {
      env: GIT_ENV,
      encoding: "utf8",
    }).trim();
  NodeFS.mkdirSync(work);
  run("checkout", "-f", first, "--", ".");
  NodeFS.writeFileSync(NodePath.join(work, "src/a.ts"), "export const a = 2;\n");
  NodeFS.rmSync(NodePath.join(work, "src/old.ts"));
  run("add", "--all");
  run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "next");
  const second = CommitSha.make(run("rev-parse", "HEAD"));
  const tree: Tree.Tree = {
    gitDir,
    workTree: NodePath.join(root, "env/repo"),
    indexFile: NodePath.join(root, "env.index"),
  };
  return { root, tree, first, second };
};

/** Every file under the work tree: its content, or where it links. */
const snapshot = (dir: string): Record<string, string> => {
  const files: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const entry of NodeFS.readdirSync(NodePath.join(dir, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink())
        files[path] = `-> ${NodeFS.readlinkSync(NodePath.join(dir, path))}`;
      else if (entry.isDirectory()) walk(path);
      else files[path] = NodeFS.readFileSync(NodePath.join(dir, path), "utf8");
    }
  };
  walk("");
  return files;
};

const trees = Effect.map(Effect.service(ChildProcessSpawner.ChildProcessSpawner), (spawner) =>
  Tree.make(spawner),
);
const path = (value: string) => RelativePath.make(value);

it.effect("lays a change over the tree in place and takes it off again", () =>
  Effect.gen(function* () {
    const { tree, first } = fixture();
    const ops = yield* trees;
    yield* ops.materialize(tree, first);
    const clean = snapshot(tree.workTree);
    // Install output the tree does not track stays where it is.
    NodeFS.mkdirSync(NodePath.join(tree.workTree, "node_modules/x"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(tree.workTree, "node_modules/x/index.js"), "1");
    const overlay = yield* ops.overlay(tree, {
      files: [
        { path: path("src/a.ts"), content: "export const a = 'x';\n" },
        { path: path("src/new/deep/b.ts"), content: "export const b = 1;\n" },
        { path: path("src/self"), content: "no longer a link\n" },
      ],
      deleted: [path("src/old.ts")],
    });
    const laid = snapshot(tree.workTree);
    assert.strictEqual(laid["src/a.ts"], "export const a = 'x';\n");
    assert.strictEqual(laid["src/new/deep/b.ts"], "export const b = 1;\n");
    assert.strictEqual(laid["src/self"], "no longer a link\n");
    assert.strictEqual(laid["src/old.ts"], undefined);
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(tree.workTree, "src/a.ts"), "utf8"),
      "export const a = 'x';\n",
    );
    yield* ops.restore(tree, overlay);
    assert.deepStrictEqual(snapshot(tree.workTree), { ...clean, "node_modules/x/index.js": "1" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses a write through a symbolic link of the tree and writes nothing", () =>
  Effect.gen(function* () {
    const { tree, first } = fixture();
    const ops = yield* trees;
    yield* ops.materialize(tree, first);
    const clean = snapshot(tree.workTree);
    const refused = yield* ops
      .overlay(tree, {
        files: [
          { path: path("link/passwd.ts"), content: "x" },
          { path: path("src/a.ts"), content: "y" },
        ],
        deleted: [path("link/hosts")],
      })
      .pipe(Effect.flip);
    assert.deepStrictEqual<ReadonlyArray<string>>(refused.paths, ["link/hosts", "link/passwd.ts"]);
    assert.deepStrictEqual(snapshot(tree.workTree), clean);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("moves the tree to another commit, deleting what it dropped", () =>
  Effect.gen(function* () {
    const { tree, first, second } = fixture();
    const ops = yield* trees;
    yield* ops.materialize(tree, first);
    yield* ops.moveTo(tree, first, second);
    const moved = snapshot(tree.workTree);
    assert.strictEqual(moved["src/a.ts"], "export const a = 2;\n");
    assert.strictEqual(moved["src/old.ts"], undefined);
    yield* ops.moveTo(tree, second, first);
    assert.strictEqual(snapshot(tree.workTree)["src/old.ts"], "export const old = 1;\n");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("takes off an overlay a crash left behind", () =>
  Effect.gen(function* () {
    const { tree, first } = fixture();
    const ops = yield* trees;
    yield* ops.materialize(tree, first);
    const clean = snapshot(tree.workTree);
    yield* ops.overlay(tree, {
      files: [{ path: path("src/z/c.ts"), content: "1" }],
      deleted: [path("src/a.ts")],
    });
    yield* ops.recover(tree);
    assert.deepStrictEqual(snapshot(tree.workTree), clean);
    yield* ops.recover(tree);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("takes an overlay off without following a link a run put in its way", () =>
  Effect.gen(function* () {
    const { root, tree, first } = fixture();
    const ops = yield* trees;
    yield* ops.materialize(tree, first);
    const outside = NodePath.join(root, "outside");
    NodeFS.mkdirSync(NodePath.join(outside, "deep"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(outside, "deep/b.ts"), "keep me");
    NodeFS.writeFileSync(NodePath.join(outside, "a.ts"), "keep me too");
    const overlay = yield* ops.overlay(tree, {
      files: [
        { path: path("src/new/deep/b.ts"), content: "1" },
        { path: path("lib/a.ts"), content: "2" },
      ],
      deleted: [],
    });
    // A check swaps the directories the overlay wrote into for links out of the tree.
    NodeFS.rmSync(NodePath.join(tree.workTree, "src/new"), { recursive: true });
    NodeFS.symlinkSync(outside, NodePath.join(tree.workTree, "src/new"));
    NodeFS.rmSync(NodePath.join(tree.workTree, "lib"), { recursive: true });
    NodeFS.symlinkSync(outside, NodePath.join(tree.workTree, "lib"));
    yield* ops.restore(tree, overlay);
    assert.strictEqual(NodeFS.readFileSync(NodePath.join(outside, "deep/b.ts"), "utf8"), "keep me");
    assert.strictEqual(NodeFS.readFileSync(NodePath.join(outside, "a.ts"), "utf8"), "keep me too");
    assert.isFalse(NodeFS.existsSync(NodePath.join(tree.workTree, "src/new")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(tree.workTree, "lib")));
  }).pipe(Effect.provide(NodeServices.layer)),
);
