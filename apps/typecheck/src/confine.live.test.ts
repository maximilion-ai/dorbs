import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { RelativePath, ToolName } from "@dorbs/protocol/typecheck";

import { EMPTY_PACKAGE, TestServer, TSCONFIG, checkChange } from "./testServer.ts";

// A commit's own files skip the import scan, so only the sandbox keeps tsrs from this file.
const CONFINED_OUTSIDE = `${NodeOS.tmpdir()}/typecheck-confine-${NodeCrypto.randomUUID()}`;

it.live.skipIf(process.platform !== "darwin")(
  "with TYPECHECK_CONFINE=1, tsrs cannot read a file outside the check",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const secret = `hunter2-${NodeCrypto.randomUUID()}`;
      yield* fs.makeDirectory(CONFINED_OUTSIDE, { recursive: true });
      yield* fs.writeFileString(
        `${CONFINED_OUTSIDE}/secret.ts`,
        `export const SECRET = "${secret}";\n`,
      );
      const response = yield* checkChange("confined", {});
      assert.deepStrictEqual(response._tag === "ActionResult" && response.diagnostics, [
        {
          tool: ToolName.make("tsrs"),
          path: RelativePath.make("src/a.ts"),
          line: 1,
          column: 24,
          code: "TS2307",
          message: `Cannot find module '${CONFINED_OUTSIDE}/secret.js' or its corresponding type declarations.`,
          severity: "error",
        },
      ]);
      assert.notInclude(JSON.stringify(response), secret);
      yield* fs.remove(CONFINED_OUTSIDE, { recursive: true });
    }).pipe(
      Effect.provide(
        TestServer(
          {
            confined: {
              "package.json": EMPTY_PACKAGE,
              "tsconfig.json": TSCONFIG,
              "src/a.ts": `import { SECRET } from "${CONFINED_OUTSIDE}/secret.js";\nexport const n: typeof SECRET = 1;\n`,
            },
          },
          { TYPECHECK_CONFINE: "1" },
        ),
      ),
    ),
  // The first sandboxed launch after a while has taken macOS several seconds.
  { timeout: 30_000 },
);
