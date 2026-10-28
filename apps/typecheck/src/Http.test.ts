import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Ref from "effect/Ref";

import { RelativePath, Sha256 } from "@dorbs/protocol/typecheck";

import {
  EMPTY_LOCKFILE,
  EMPTY_PACKAGE,
  SpawnLog,
  TestServer,
  TOKEN,
  TSCONFIG,
  checkProject,
  postCheck,
  upload,
} from "./testServer.ts";

const project = (source: string) => ({
  "package.json": EMPTY_PACKAGE,
  "tsconfig.json": TSCONFIG,
  "src/a.ts": source,
});

it.live("answers MissingBlobs with exactly the unknown lockfile and file hashes", () =>
  Effect.gen(function* () {
    yield* upload("export const a = 1;\n");
    const response = yield* postCheck(EMPTY_LOCKFILE, {
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
    });
    assert.deepStrictEqual(response, {
      _tag: "MissingBlobs",
      sha256s: [
        Sha256.make("17c814b167307942d3609c7b9d916ceddb85839573ab39baa114e30edb132a1a"),
        Sha256.make("68acba1fdd044961e944f6feef2bfe34303055f8ed206c41d19c0870033e8772"),
      ],
    });
  }).pipe(Effect.provide(TestServer)),
);

it.live("reports a planted type error from tsrs with its project path and position", () =>
  Effect.gen(function* () {
    const response = yield* checkProject(
      EMPTY_LOCKFILE,
      project('const n: number = "x";\nexport { n };\n'),
    );
    assert.strictEqual(response._tag, "CheckResult");
    if (response._tag !== "CheckResult") return;
    assert.deepStrictEqual(response.diagnostics, [
      {
        tool: "tsrs",
        path: RelativePath.make("src/a.ts"),
        line: 1,
        column: 7,
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
        severity: "error",
      },
    ]);
    assert.isAbove(response.durationMs, 0);
  }).pipe(Effect.provide(TestServer)),
);

it.live("reports an oxlint finding with tool oxlint", () =>
  Effect.gen(function* () {
    const response = yield* checkProject(EMPTY_LOCKFILE, project("debugger;\nexport {};\n"));
    assert.deepStrictEqual(response._tag === "CheckResult" && response.diagnostics, [
      {
        tool: "oxlint",
        path: RelativePath.make("src/a.ts"),
        line: 1,
        column: 1,
        code: "eslint(no-debugger)",
        message: "`debugger` statement is not allowed",
        severity: "warning",
      },
    ]);
  }).pipe(Effect.provide(TestServer)),
);

it.live("ignores the project's oxlint configs, so their jsPlugins never run", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const marker = `${yield* fs.makeTempDirectoryScoped()}/plugin-ran`;
    const plugin = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");\nmodule.exports = { meta: { name: "p" }, rules: {} };\n`;
    const response = yield* checkProject(EMPTY_LOCKFILE, {
      ...project("debugger;\nexport {};\n"),
      "plugin.cjs": plugin,
      ".oxlintrc.json": '{ "jsPlugins": ["./plugin.cjs"], "rules": { "no-debugger": "off" } }',
      "src/.oxlintrc.json": '{ "jsPlugins": ["../plugin.cjs"] }',
    });
    assert.deepStrictEqual(
      response._tag === "CheckResult" && response.diagnostics.map((d) => `${d.path} ${d.code}`),
      ["src/a.ts eslint(no-debugger)"],
    );
    assert.isFalse(yield* fs.exists(marker));
  }).pipe(Effect.provide(TestServer)),
);

it.live("rejects a blob whose content does not match its hash and does not store it", () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const hashOfA = Sha256.make("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
    const response = yield* client.execute(
      HttpClientRequest.put(`/blobs/${hashOfA}`).pipe(
        HttpClientRequest.bearerToken(TOKEN),
        HttpClientRequest.bodyText("b"),
      ),
    );
    assert.strictEqual(response.status, 422);
    assert.strictEqual(
      yield* response.text,
      `Blob content hashes to 3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d, not ${hashOfA}`,
    );
    const check = yield* postCheck(EMPTY_LOCKFILE, { "src/a.ts": "a" });
    assert.deepStrictEqual(check, {
      _tag: "MissingBlobs",
      sha256s: [
        Sha256.make("17c814b167307942d3609c7b9d916ceddb85839573ab39baa114e30edb132a1a"),
        hashOfA,
      ],
    });
  }).pipe(Effect.provide(TestServer)),
);

it.live("answers 401 on every route without the right bearer token", () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const blob = HttpClientRequest.put(
      "/blobs/ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    ).pipe(HttpClientRequest.bodyText("a"));
    const check = HttpClientRequest.post("/check").pipe(
      HttpClientRequest.bodyText('{"lockfile":"x","files":[]}', "application/json"),
    );
    const statuses = yield* Effect.forEach(
      [
        blob,
        check,
        blob.pipe(HttpClientRequest.bearerToken("wrong")),
        check.pipe(HttpClientRequest.bearerToken("wrong")),
        check.pipe(HttpClientRequest.setHeader("authorization", TOKEN)),
      ],
      (request) => client.execute(request).pipe(Effect.map((response) => response.status)),
    );
    assert.deepStrictEqual(statuses, [401, 401, 401, 401, 401]);
  }).pipe(Effect.provide(TestServer)),
);

it.live("runs one install for two concurrent checks on a new lockfile", () =>
  Effect.gen(function* () {
    const files = project("export const a = 1;\n");
    const responses = yield* Effect.all(
      [checkProject(EMPTY_LOCKFILE, files), checkProject(EMPTY_LOCKFILE, files)],
      { concurrency: "unbounded" },
    );
    assert.deepStrictEqual(
      responses.map((response) => response._tag === "CheckResult" && response.diagnostics),
      [[], []],
    );
    const installs = (yield* Ref.get(yield* SpawnLog)).filter((line) =>
      line.startsWith("pnpm install"),
    );
    assert.strictEqual(installs.length, 1);
  }).pipe(Effect.provide(TestServer)),
);
