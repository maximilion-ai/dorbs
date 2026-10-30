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
        pnpm: {
          patchedDependencies: { "@vue/test-utils@2.4.6": "patches/@vue__test-utils.patch" },
        },
      }),
      "patchedDependencies:\n  acorn@8.11.3: patches/acorn@8.11.3.patch\n",
    ),
    { files: ["patches/@vue__test-utils.patch", "patches/acorn@8.11.3.patch"], refused: [] },
  );
  assert.deepStrictEqual(patchFiles("not json", undefined), { files: [], refused: [] });
  assert.deepStrictEqual(patchFiles(undefined, "packages: [.]\n"), { files: [], refused: [] });
});

// pnpm reads a patch from where the config says, and a staged .npmrc or package.json would steer it.
it("refuses a patch entry that is not a plain .patch path inside the repo", () => {
  assert.deepStrictEqual(
    patchFiles(
      JSON.stringify({ pnpm: { patchedDependencies: { a: ".npmrc", b: 1 } } }),
      `patchedDependencies:
  c: ../../etc/passwd
  d: /etc/x.patch
  e: patches/.hidden.patch
  f: node_modules/x.patch
  g: patches/package.json
  h: { path: x.patch }
  <<: { i: patches/i.patch }
  j: patches/ok.patch
`,
    ),
    {
      files: ["patches/ok.patch"],
      refused: [
        "a: .npmrc",
        "b: 1",
        "c: ../../etc/passwd",
        "d: /etc/x.patch",
        "e: patches/.hidden.patch",
        "f: node_modules/x.patch",
        "g: patches/package.json",
        'h: {"path":"x.patch"}',
        '<<: {"i":"patches/i.patch"}',
      ],
    },
  );
  assert.strictEqual(
    installWorkspace("patchedDependencies:\n  j: patches/ok.patch\n  c: ../x\n  <<: { i: y }\n"),
    "patchedDependencies:\n  j: patches/ok.patch\n",
  );
});
