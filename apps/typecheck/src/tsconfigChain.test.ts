import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { tsconfigChain } from "./tsconfigChain.ts";

const chainOf = (files: Record<string, string>) =>
  tsconfigChain((path) => Effect.succeed(files[path])).pipe(
    Effect.map((chain) => [...chain.files].toSorted()),
  );

const unsafeOf = (files: Record<string, string>) =>
  tsconfigChain((path) => Effect.succeed(files[path])).pipe(
    Effect.map((chain) => chain.unsafe.toSorted()),
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

it.effect("names every option in the chain that writes files or reaches outside the repo", () =>
  Effect.gen(function* () {
    const unsafe = yield* unsafeOf({
      "tsconfig.json": `{
        "extends": ["./config/base", "@tsconfig/strictest/tsconfig.json"],
        "files": ["src/main.ts"],
        "include": ["src", "\${configDir}/types"],
        "references": [{ "path": "./packages/a" }],
        "compilerOptions": {
          "incremental": false,
          "rootDir": ".",
          "paths": { "@/*": ["./src/*"] },
          "typeRoots": ["./types"],
          "types": ["node"],
          "jsxImportSource": "preact",
        },
      }`,
      "config/base.json": `{
        "extends": "/etc/base.json",
        "compilerOptions": {
          "incremental": true,
          "tsBuildInfoFile": "/tmp/x.tsbuildinfo",
          "rootDirs": ["..", "../.."],
          "composite": true,
          "outDir": "../dist",
          "plugins": [],
        },
      }`,
      "packages/a/tsconfig.json": `{
        "extends": "pkg/../../../../etc/x.json",
        "files": ["/Users/op/secret.ts"],
        "include": ["\${configDir}/../../../outside"],
        "references": [{ "path": "../../../sibling" }],
        "compilerOptions": {
          "outFile": "out.js",
          "declarationDir": "types",
          "paths": { "@/*": ["../../../x/*"] },
          "typeRoots": ["/usr/lib/types"],
          "types": ["../../../evil"],
          "jsxImportSource": "/abs/react",
          "rootDir": "../..\\\\..",
        },
      }`,
    });
    assert.deepStrictEqual(unsafe, [
      "config/base.json: compilerOptions.composite",
      "config/base.json: compilerOptions.incremental",
      "config/base.json: compilerOptions.outDir",
      "config/base.json: compilerOptions.plugins",
      "config/base.json: compilerOptions.rootDirs",
      "config/base.json: compilerOptions.tsBuildInfoFile",
      "config/base.json: extends",
      "packages/a/tsconfig.json: compilerOptions.declarationDir",
      "packages/a/tsconfig.json: compilerOptions.jsxImportSource",
      "packages/a/tsconfig.json: compilerOptions.outFile",
      "packages/a/tsconfig.json: compilerOptions.paths",
      "packages/a/tsconfig.json: compilerOptions.rootDir",
      "packages/a/tsconfig.json: compilerOptions.typeRoots",
      "packages/a/tsconfig.json: compilerOptions.types",
      "packages/a/tsconfig.json: extends",
      "packages/a/tsconfig.json: files",
      "packages/a/tsconfig.json: include",
      "packages/a/tsconfig.json: references",
    ]);
  }),
);
