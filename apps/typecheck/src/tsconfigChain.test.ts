import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { tsconfigChain } from "./tsconfigChain.ts";

const chainOf = (files: Record<string, string>) =>
  tsconfigChain((path) => Effect.succeed(files[path])).pipe(
    Effect.map((chain) => [...chain].toSorted()),
  );

it.effect("follows relative extends and references through JSON with comments", () =>
  Effect.gen(function* () {
    const chain = yield* chainOf({
      "tsconfig.json": `{
        // "extends": "./commented-out.json",
        "extends": ["./config/base", "@tsconfig/strictest/tsconfig.json"],
        "compilerOptions": { "paths": { "@/*": ["./src/*"] }, },
        /* "references": [{ "path": "./hidden" }] */
        "references": [{ "path": "./packages/a" }, { "path": "./packages/b/build.json" },],
      }`,
      "config/base.json": '{ "extends": "../shared/settings.jsonc" }',
      "shared/settings.jsonc": "{}",
      "packages/a/tsconfig.json": '{ "extends": "../../config/base.json" }',
      "packages/b/build.json": '{ "references": [{ "path": "../../../outside" }] }',
    });
    assert.deepStrictEqual(chain, [
      "config/base",
      "config/base.json",
      "packages/a/tsconfig.json",
      "packages/b/build.json",
      "shared/settings.jsonc",
      "shared/settings.jsonc.json",
      "tsconfig.json",
    ]);
  }),
);

it.effect("names only tsconfig.json when the commit has none", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* chainOf({}), ["tsconfig.json"]);
  }),
);
