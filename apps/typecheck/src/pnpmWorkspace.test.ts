import { assert, it } from "@effect/vitest";

import { installWorkspace } from "./pnpmWorkspace.ts";

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
`,
  );
});

it("writes an empty map for a workspace file with nothing to keep", () => {
  assert.strictEqual(installWorkspace("modulesDir: ../out\n"), "{}\n");
});
