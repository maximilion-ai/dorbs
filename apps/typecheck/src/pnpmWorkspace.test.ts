import { assert, it } from "@effect/vitest";

import { installWorkspace, patchFiles } from "./pnpmWorkspace.ts";

it("keeps resolution settings and drops paths, hooks and globs that leave the root", () => {
  assert.strictEqual(
    installWorkspace(`packages:
  - apps/*
  - "!apps/legacy"
  - ../../installs/other
  - /etc
  - "{..,apps}/x"
  - "apps/[.][.]/x"
  - apps\\..\\x
  - "!/etc"
catalog:
  effect: 4.0.6
overrides:
  vite: "catalog:"
autoInstallPeers: true
patchedDependencies:
  acorn@8.11.3: patches/acorn@8.11.3.patch
modulesDir: ../../escaped
virtualStoreDir: /data/installs/other
storeDir: /tmp/store
pnpmfile: /tmp/hooks.cjs
registry: https://registry.example.test/
`),
    `packages:
  - apps/*
  - "!apps/legacy"
catalog:
  effect: 4.0.6
overrides:
  vite: "catalog:"
autoInstallPeers: true
patchedDependencies:
  acorn@8.11.3: patches/acorn@8.11.3.patch
`,
  );
});

it("writes an empty map for a workspace file with nothing to keep", () => {
  assert.strictEqual(installWorkspace("modulesDir: ../out\n"), "{}\n");
});

it("names the patch files of package.json's pnpm field and of pnpm-workspace.yaml", () => {
  assert.deepStrictEqual(
    patchFiles(
      JSON.stringify({
        pnpm: { patchedDependencies: { "@vue/test-utils@2.4.6": "patches/vue.patch", x: 1 } },
      }),
      "patchedDependencies:\n  acorn@8.11.3: patches/acorn.patch\n  evil: ../../etc/passwd\n",
    ),
    ["patches/vue.patch", "patches/acorn.patch", "../../etc/passwd"],
  );
  assert.deepStrictEqual(patchFiles("not json", undefined), []);
  assert.deepStrictEqual(patchFiles(undefined, "packages: [.]\n"), []);
});
