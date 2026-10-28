import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  Action,
  ActionResponse,
  CommitSha,
  RelativePath,
  RepoId,
  Sha256,
  ToolchainId,
  ToolName,
  isProtectedPath,
} from "./typecheck.ts";

const ActionJson = Schema.fromJsonString(Action);
const decodeAction = Schema.decodeEffect(ActionJson);
const encodeAction = Schema.encodeEffect(ActionJson);
const decodeActionResponse = Schema.decodeEffect(Schema.fromJsonString(ActionResponse));

const COMMIT = "c085b16bedd5a7a4ee935124edd739de2d0f634d";
const BLOB = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";

const TOOLCHAIN = "node26-tsrs0.20-oxlint1.89";

const actionJson = (fields: {
  kind?: string;
  toolchain?: string;
  repo?: string;
  commit?: string;
  files?: string;
  deleted?: string;
}) =>
  `{"kind":${JSON.stringify(fields.kind ?? "check")},"toolchain":${JSON.stringify(fields.toolchain ?? TOOLCHAIN)},"repo":${JSON.stringify(fields.repo ?? "maximilion/dorbs")},"commit":${JSON.stringify(fields.commit ?? COMMIT)},"files":${fields.files ?? "[]"},"deleted":${fields.deleted ?? "[]"}}`;

const rejection = (json: string) =>
  decodeAction(json).pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

it.effect("round-trips an Action through JSON", () =>
  Effect.gen(function* () {
    const json = actionJson({
      files: `[{"path":"src/a.ts","sha256":"${BLOB}"}]`,
      deleted: '["src/old.ts"]',
    });
    const request = yield* decodeAction(json);
    assert.deepStrictEqual(request, {
      kind: "check",
      toolchain: ToolchainId.make(TOOLCHAIN),
      repo: RepoId.make("maximilion/dorbs"),
      commit: CommitSha.make(COMMIT),
      files: [{ path: RelativePath.make("src/a.ts"), sha256: Sha256.make(BLOB) }],
      deleted: [RelativePath.make("src/old.ts")],
    });
    assert.strictEqual(yield* encodeAction(request), json);
  }),
);

it.effect("rejects an action kind or toolchain id it does not know the shape of", () =>
  Effect.gen(function* () {
    assert.strictEqual(
      yield* rejection(actionJson({ kind: "build" })),
      'Expected "check"\n  at ["kind"]',
    );
    assert.strictEqual(
      yield* rejection(actionJson({ toolchain: "Node 26" })),
      'Expected a toolchain id\n  at ["toolchain"]',
    );
  }),
);

it.effect("accepts owner/name repo ids and rejects anything else", () =>
  Effect.gen(function* () {
    for (const repo of ["maximilion/dorbs", "fakts/fakts.org", "a-b/c_d.e"]) {
      assert.strictEqual((yield* decodeAction(actionJson({ repo }))).repo, repo);
    }
    for (const repo of [
      "Maximilion/dorbs",
      "dorbs",
      "a/b/c",
      "../dorbs",
      "a/..",
      "a/.",
      "a b/c",
      "/a",
    ]) {
      assert.strictEqual(
        yield* rejection(actionJson({ repo })),
        'Expected a repo id such as owner/name\n  at ["repo"]',
        repo,
      );
    }
  }),
);

it.effect("rejects a commit that is not 40 lowercase hex characters", () =>
  Effect.gen(function* () {
    for (const commit of [COMMIT.toUpperCase(), COMMIT.slice(1), "main", `${COMMIT}0`]) {
      assert.strictEqual(
        yield* rejection(actionJson({ commit })),
        'Expected a full lowercase hex commit SHA\n  at ["commit"]',
        commit,
      );
    }
  }),
);

it.effect("rejects a Sha256 that is not 64 lowercase hex characters", () =>
  Effect.gen(function* () {
    assert.strictEqual(
      yield* rejection(
        actionJson({ files: `[{"path":"src/a.ts","sha256":"${BLOB.toUpperCase()}"}]` }),
      ),
      'Expected a lowercase hex SHA-256\n  at ["files"][0]["sha256"]',
    );
  }),
);

it.effect("rejects paths that escape the project root", () =>
  Effect.gen(function* () {
    for (const path of [
      "/etc/passwd",
      "../a.ts",
      "a\n/../b.ts",
      "a\u0001b.ts",
      "src/../../a.ts",
      "src//a.ts",
      "./a.ts",
      "a\\b.ts",
    ]) {
      assert.strictEqual(
        yield* rejection(actionJson({ deleted: JSON.stringify([path]) })),
        'Expected a relative POSIX path without . or .. segments\n  at ["deleted"][0]',
        path,
      );
    }
  }),
);

it("protects dependency and tool config at any depth, in any case", () => {
  const verdicts = Object.fromEntries(
    [
      "package.json",
      "packages/a/package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      "apps/web/.npmrc",
      "tsconfig.json",
      "tsconfig.base.json",
      "packages/a/tsconfig.build.json",
      ".oxlintrc.json",
      "src/.oxlintrc.strict.json",
      "oxlint.config.ts",
      "node_modules/zod/index.d.ts",
      "packages/a/Node_Modules/x.ts",
      "Package.JSON",
      "TSCONFIG.JSON",
      "src/index.ts",
      "src/package.ts",
      "package.json.ts",
      "src/tsconfig.ts",
      "docs/npmrc.md",
      "lockfile.yaml",
      "src/node_modules.ts",
    ].map((path) => [path, isProtectedPath(RelativePath.make(path))]),
  );
  assert.deepStrictEqual(verdicts, {
    "package.json": true,
    "packages/a/package.json": true,
    "pnpm-lock.yaml": true,
    "pnpm-workspace.yaml": true,
    ".npmrc": true,
    "apps/web/.npmrc": true,
    "tsconfig.json": true,
    "tsconfig.base.json": true,
    "packages/a/tsconfig.build.json": true,
    ".oxlintrc.json": true,
    "src/.oxlintrc.strict.json": true,
    "oxlint.config.ts": true,
    "node_modules/zod/index.d.ts": true,
    "packages/a/Node_Modules/x.ts": true,
    "Package.JSON": true,
    "TSCONFIG.JSON": true,
    "src/index.ts": false,
    "src/package.ts": false,
    "package.json.ts": false,
    "src/tsconfig.ts": false,
    "docs/npmrc.md": false,
    "lockfile.yaml": false,
    "src/node_modules.ts": false,
  });
});

it.effect("tells MissingBlobs, ActionResult and Rejected apart by _tag", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* decodeActionResponse(`{"_tag":"MissingBlobs","sha256s":["${BLOB}"]}`),
      {
        _tag: "MissingBlobs",
        sha256s: [Sha256.make(BLOB)],
      },
    );
    assert.deepStrictEqual(
      yield* decodeActionResponse(
        '{"_tag":"ActionResult","durationMs":412,"cached":true,"outputs":[{"path":"src/gen.ts","sha256":"BLOB"}],"diagnostics":[{"tool":"ruff","path":"src/a.ts","line":3,"column":14,"code":"TS2322","message":"Type \'string\' is not assignable to type \'number\'.","severity":"error"}]}'.replace(
          "BLOB",
          BLOB,
        ),
      ),
      {
        _tag: "ActionResult",
        durationMs: 412,
        cached: true,
        outputs: [{ path: RelativePath.make("src/gen.ts"), sha256: Sha256.make(BLOB) }],
        diagnostics: [
          {
            tool: ToolName.make("ruff"),
            path: RelativePath.make("src/a.ts"),
            line: 3,
            column: 14,
            code: "TS2322",
            message: "Type 'string' is not assignable to type 'number'.",
            severity: "error",
          },
        ],
      },
    );
    assert.deepStrictEqual(
      yield* decodeActionResponse(
        '{"_tag":"Rejected","reason":{"_tag":"ProtectedPaths","paths":["package.json"]}}',
      ),
      {
        _tag: "Rejected",
        reason: { _tag: "ProtectedPaths", paths: [RelativePath.make("package.json")] },
      },
    );
    assert.deepStrictEqual(
      yield* decodeActionResponse('{"_tag":"Rejected","reason":{"_tag":"UnknownCommit"}}'),
      { _tag: "Rejected", reason: { _tag: "UnknownCommit" } },
    );
    assert.deepStrictEqual(
      yield* decodeActionResponse('{"_tag":"Rejected","reason":{"_tag":"UnknownToolchain"}}'),
      { _tag: "Rejected", reason: { _tag: "UnknownToolchain" } },
    );
    const emptyTool = yield* decodeActionResponse(
      '{"_tag":"ActionResult","durationMs":1,"cached":false,"outputs":[],"diagnostics":[{"tool":"","path":"a.ts","line":1,"column":1,"code":"x","message":"x","severity":"error"}]}',
    ).pipe(Effect.flip);
    assert.include(emptyTool.message, 'at ["diagnostics"][0]["tool"]');
  }),
);
