import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { RelativePath } from "@dorbs/protocol/typecheck";

import { TestServer, TSCONFIG, checkProject } from "./testServer.ts";

const ZOD_PACKAGE = `{
  "name": "fixture",
  "private": true,
  "type": "module",
  "dependencies": {
    "zod": "3.25.76"
  }
}
`;

const ZOD_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      zod:
        specifier: 3.25.76
        version: 3.25.76

packages:

  zod@3.25.76:
    resolution: {integrity: sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==}

snapshots:

  zod@3.25.76: {}
`;

const SOURCE = `import { z } from "zod";

const User = z.object({ name: z.string() });

export const user: z.infer<typeof User> = { name: 1 };
`;

// Installs zod from the npm registry. Set TYPECHECK_OFFLINE=1 to skip it without network.
it.live.skipIf(process.env["TYPECHECK_OFFLINE"] === "1")(
  "reports a type error that only exists through an installed dependency",
  () =>
    Effect.gen(function* () {
      const response = yield* checkProject(ZOD_LOCKFILE, {
        "package.json": ZOD_PACKAGE,
        "tsconfig.json": TSCONFIG,
        "src/index.ts": SOURCE,
      });
      assert.deepStrictEqual(response._tag === "CheckResult" && response.diagnostics, [
        {
          tool: "tsrs",
          path: RelativePath.make("src/index.ts"),
          line: 5,
          column: 45,
          code: "TS2322",
          message: "Type 'number' is not assignable to type 'string'.",
          severity: "error",
        },
      ]);
    }).pipe(Effect.provide(TestServer)),
  { timeout: 60_000 },
);
