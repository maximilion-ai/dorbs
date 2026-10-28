import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CheckRequest, CheckResponse, RelativePath, Sha256 } from "./typecheck.ts";

const CheckRequestJson = Schema.fromJsonString(CheckRequest);
const decodeCheckRequest = Schema.decodeEffect(CheckRequestJson);
const encodeCheckRequest = Schema.encodeEffect(CheckRequestJson);
const decodeCheckResponse = Schema.decodeEffect(Schema.fromJsonString(CheckResponse));

const LOCKFILE = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const BLOB = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";

it.effect("round-trips a CheckRequest through JSON", () =>
  Effect.gen(function* () {
    const json = `{"lockfile":"${LOCKFILE}","files":[{"path":"src/a.ts","sha256":"${BLOB}"}]}`;
    const request = yield* decodeCheckRequest(json);
    assert.deepStrictEqual(request, {
      lockfile: Sha256.make(LOCKFILE),
      files: [{ path: RelativePath.make("src/a.ts"), sha256: Sha256.make(BLOB) }],
    });
    assert.strictEqual(yield* encodeCheckRequest(request), json);
  }),
);

it.effect("rejects a Sha256 that is not 64 lowercase hex characters", () =>
  Effect.gen(function* () {
    const error = yield* decodeCheckRequest(
      `{"lockfile":"${LOCKFILE.toUpperCase()}","files":[]}`,
    ).pipe(Effect.flip);
    assert.strictEqual(error._tag, "SchemaError");
    assert.strictEqual(error.message, 'Expected a lowercase hex SHA-256\n  at ["lockfile"]');
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
      const error = yield* decodeCheckRequest(
        `{"lockfile":"${LOCKFILE}","files":[{"path":${JSON.stringify(path)},"sha256":"${BLOB}"}]}`,
      ).pipe(Effect.flip);
      assert.strictEqual(
        error.message,
        'Expected a relative POSIX path without . or .. segments\n  at ["files"][0]["path"]',
        path,
      );
    }
  }),
);

it.effect("tells MissingBlobs from CheckResult by _tag", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* decodeCheckResponse(`{"_tag":"MissingBlobs","sha256s":["${BLOB}"]}`),
      {
        _tag: "MissingBlobs",
        sha256s: [Sha256.make(BLOB)],
      },
    );
    assert.deepStrictEqual(
      yield* decodeCheckResponse(
        '{"_tag":"CheckResult","durationMs":412,"diagnostics":[{"tool":"tsrs","path":"src/a.ts","line":3,"column":14,"code":"TS2322","message":"Type \'string\' is not assignable to type \'number\'.","severity":"error"}]}',
      ),
      {
        _tag: "CheckResult",
        durationMs: 412,
        diagnostics: [
          {
            tool: "tsrs",
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
  }),
);
