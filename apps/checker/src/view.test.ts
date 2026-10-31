import { assert, it } from "@effect/vitest";

import { RelativePath } from "@dorbs/protocol/typecheck";

import { setupChange, viewOf } from "./view.ts";

const path = (value: string) => RelativePath.make(value);
const COMMIT = {
  paths: [path("package.json"), path(".npmrc"), path(".dorbs/check.json"), path("src/a.ts")],
  inputs: new Map([
    ["package.json", "{}"],
    [".npmrc", "registry=https://registry.npmjs.org/"],
    [".dorbs/check.json", '{"checks":[]}'],
  ]),
};
const CHANGE = {
  files: [
    { path: path("package.json"), content: '{"dependencies":{"x":"1"}}' },
    { path: path(".npmrc"), content: "registry=https://evil.example/" },
    { path: path(".yarnrc.yml"), content: "yarnPath: evil.cjs" },
    {
      path: path(".dorbs/check.json"),
      content: '{"setup":[{"id":"x","run":"curl evil","network":true}]}',
    },
    { path: path("src/b.ts"), content: "" },
  ],
  deleted: [path("src/a.ts"), path(".npmrc")],
};

it("lays the change's manifests and lockfiles over the commit, but not its package manager config", () => {
  const view = viewOf(COMMIT.paths, COMMIT.inputs, CHANGE, undefined);
  assert.strictEqual(view.read("package.json"), '{"dependencies":{"x":"1"}}');
  assert.strictEqual(view.read(".npmrc"), "registry=https://registry.npmjs.org/");
  assert.strictEqual(view.read(".yarnrc.yml"), undefined);
  assert.strictEqual(view.read(".dorbs/check.json"), '{"checks":[]}');
  assert.deepStrictEqual<ReadonlyArray<string>>(view.paths, [
    ".dorbs/check.json",
    ".npmrc",
    "package.json",
    "src/b.ts",
  ]);
});

it("takes the operator's recipe over the commit's", () => {
  const view = viewOf(COMMIT.paths, COMMIT.inputs, CHANGE, '{"checks":[{"id":"x","run":"y"}]}');
  assert.strictEqual(view.read(".dorbs/check.json"), '{"checks":[{"id":"x","run":"y"}]}');
});

it("lays only the change's key files that may change over the tree during setup", () => {
  const keyFiles = new Set(["package.json", ".npmrc", ".yarnrc.yml", ".dorbs/check.json"]);
  assert.deepStrictEqual<unknown>(setupChange(CHANGE, keyFiles), {
    files: [CHANGE.files[0]],
    deleted: [],
  });
});
