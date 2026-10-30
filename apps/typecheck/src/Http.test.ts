import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Ref from "effect/Ref";

import {
  type ActionResponse,
  type Diagnostic,
  RelativePath,
  Sha256,
  ToolName,
} from "@dorbs/protocol/typecheck";

import {
  EMPTY_PACKAGE,
  Fixtures,
  LogLines,
  PeakRunning,
  PRIVATE_TOKEN,
  SpawnLog,
  TestServer,
  TOKEN,
  TSCONFIG,
  checkChange,
  postCheck,
  postCheckRaw,
  upload,
} from "./testServer.ts";

// The root tsconfig extends a file whose name the protected table does not know.
const FIXTURE = {
  "package.json": EMPTY_PACKAGE,
  "tsconfig.json": '{ "extends": "./config/strict", "include": ["src"] }\n',
  "config/strict.json": TSCONFIG,
  "src/a.ts": "export const a = 1;\n",
  "src/bad.ts": 'export const n: number = "x";\n',
  // A committed oxlint config still does not apply: its plugin would run as code in the service.
  ".oxlintrc.json": '{ "jsPlugins": ["./plugin.cjs"], "rules": { "no-debugger": "off" } }\n',
  "plugin.cjs": 'throw new Error("the service loaded a project oxlint plugin");\n',
};

const Server = TestServer({ fixture: FIXTURE });

const BAD_TS: Diagnostic = {
  tool: ToolName.make("tsrs"),
  path: RelativePath.make("src/bad.ts"),
  line: 1,
  column: 14,
  code: "TS2322",
  message: "Type 'string' is not assignable to type 'number'.",
  severity: "error",
};

const spawned = Effect.gen(function* () {
  return yield* Ref.get(yield* SpawnLog);
});

it.live("checks the commit's tree with the changed files laid over it", () =>
  Effect.gen(function* () {
    const response = yield* checkChange("fixture", {
      files: { "src/a.ts": "debugger;\nexport const a = 1;\n" },
    });
    assert.strictEqual(response._tag, "ActionResult");
    if (response._tag !== "ActionResult") return;
    assert.deepStrictEqual(response.diagnostics, [
      BAD_TS,
      {
        tool: ToolName.make("oxlint"),
        path: RelativePath.make("src/a.ts"),
        line: 1,
        column: 1,
        code: "eslint(no-debugger)",
        message: "`debugger` statement is not allowed",
        severity: "warning",
      },
    ]);
    assert.isAbove(response.durationMs, 0);
  }).pipe(Effect.provide(Server)),
);

it.live("drops the diagnostics of a file the client deleted", () =>
  Effect.gen(function* () {
    const response = yield* checkChange("fixture", { deleted: ["src/bad.ts"] });
    assert.deepStrictEqual(response._tag === "ActionResult" && response.diagnostics, []);
    const kept = yield* checkChange("fixture", {});
    assert.deepStrictEqual(kept._tag === "ActionResult" && kept.diagnostics, [BAD_TS]);
  }).pipe(Effect.provide(Server)),
);

it.live("answers MissingBlobs with exactly the unknown file hashes", () =>
  Effect.gen(function* () {
    yield* upload("export const a = 1;\n");
    const response = yield* postCheck("fixture", {
      files: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" },
    });
    assert.deepStrictEqual(response, {
      _tag: "MissingBlobs",
      sha256s: [Sha256.make("b5d546753d33709dff508a6f2c2e547f432267fbb05b68d3da74fa5f7bda9f7a")],
    });
  }).pipe(Effect.provide(Server)),
);

it.live("answers an identical action from the action cache without running a tool", () =>
  Effect.gen(function* () {
    const change = { files: { "src/c.ts": 'export const c: number = "c";\n' } };
    const first = yield* checkChange("fixture", change);
    const ranBefore = (yield* spawned).length;
    const second = yield* checkChange("fixture", change);
    const C_TS = { ...BAD_TS, path: RelativePath.make("src/c.ts") };
    assert.deepStrictEqual(
      [first, second].map((response) =>
        response._tag === "ActionResult"
          ? {
              diagnostics: response.diagnostics,
              outputs: response.outputs,
              cached: response.cached,
            }
          : response,
      ),
      [
        { diagnostics: [BAD_TS, C_TS], outputs: [], cached: false },
        { diagnostics: [BAD_TS, C_TS], outputs: [], cached: true },
      ],
    );
    assert.deepStrictEqual(
      (yield* spawned).slice(ranBefore),
      [],
      "the second action spawned nothing",
    );
    assert.isAbove(ranBefore, 0);
  }).pipe(Effect.provide(Server)),
);

it.live("rejects a toolchain the service does not run, before any work", () =>
  Effect.gen(function* () {
    const response = yield* postCheck("fixture", { toolchain: "node20-tsc5.4" });
    assert.deepStrictEqual(response, { _tag: "Rejected", reason: { _tag: "UnknownToolchain" } });
    assert.deepStrictEqual(yield* spawned, []);
  }).pipe(Effect.provide(Server)),
);

it.live("keeps a client write inside its check when the commit has a symlink", () =>
  Effect.gen(function* () {
    // src/root points at the tree root, so src/root/src/a.ts would be the shared checkout's src/a.ts.
    const poisoned = yield* postCheckRaw("linked", {
      files: { "src/root/src/a.ts": 'export const a: number = "poisoned";\n' },
    });
    yield* upload('export const a: number = "poisoned";\n');
    const retried = yield* postCheckRaw("linked", {
      files: { "src/root/src/a.ts": 'export const a: number = "poisoned";\n' },
    });
    const clean = yield* checkChange("linked", { files: { "src/b.ts": "export const b = 2;\n" } });
    assert.deepStrictEqual(
      [poisoned.status, retried.status, clean._tag === "ActionResult" && clean.diagnostics],
      [200, 500, []],
    );
  }).pipe(
    Effect.provide(
      TestServer({
        linked: {
          "package.json": EMPTY_PACKAGE,
          "tsconfig.json": TSCONFIG,
          "src/a.ts": "export const a = 1;\n",
          "src/root": { symlink: ".." },
        },
      }),
    ),
  ),
);

it.live("installs inside its own directory whatever the commit's pnpm-workspace.yaml says", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const response = yield* checkChange("workspace", {});
    assert.deepStrictEqual(response._tag === "ActionResult" && response.diagnostics, []);
    const { dataDir } = yield* Fixtures;
    assert.deepStrictEqual(yield* fs.readDirectory(dataDir), [
      "actions",
      "blobs",
      "checkouts",
      "checks",
      "git",
      "installs",
      "oxlintrc.json",
      "pnpm-store",
    ]);
  }).pipe(
    Effect.provide(
      TestServer({
        workspace: {
          "package.json": EMPTY_PACKAGE,
          "pnpm-workspace.yaml": 'packages: ["."]\nmodulesDir: ../../escaped\n',
          "tsconfig.json": TSCONFIG,
          "src/a.ts": "export const a = 1;\n",
        },
      }),
    ),
  ),
);

it.live("rejects an unregistered repo before any work", () =>
  Effect.gen(function* () {
    const response = yield* postCheck("fixture", {
      repo: "test/unregistered",
      files: { "src/a.ts": "never uploaded" },
    });
    assert.deepStrictEqual(response, { _tag: "Rejected", reason: { _tag: "UnknownRepo" } });
    assert.deepStrictEqual(yield* spawned, []);
  }).pipe(Effect.provide(Server)),
);

it.live("rejects changed or deleted dependency and config files before any work", () =>
  Effect.gen(function* () {
    const response = yield* postCheck("fixture", {
      files: { "package.json": "{}", "src/a.ts": "never uploaded", "src/node_modules/x.ts": "" },
      deleted: ["tsconfig.json", "src/bad.ts"],
    });
    assert.deepStrictEqual(response, {
      _tag: "Rejected",
      reason: {
        _tag: "ProtectedPaths",
        paths: [
          RelativePath.make("package.json"),
          RelativePath.make("src/node_modules/x.ts"),
          RelativePath.make("tsconfig.json"),
        ],
      },
    });
    assert.deepStrictEqual(yield* spawned, []);
  }).pipe(Effect.provide(Server)),
);

it.live("rejects a change to a file the commit's tsconfig extends, whatever its name", () =>
  Effect.gen(function* () {
    const response = yield* checkChange("fixture", {
      files: { "config/strict.json": "{}", "config/strict": "{}", "src/a.ts": "export {};\n" },
    });
    assert.deepStrictEqual(response, {
      _tag: "Rejected",
      reason: {
        _tag: "ProtectedPaths",
        paths: [RelativePath.make("config/strict.json"), RelativePath.make("config/strict")],
      },
    });
    assert.deepStrictEqual(
      (yield* spawned).filter((line) => !line.startsWith("git ")),
      [],
      "no install and no tool ran",
    );
  }).pipe(Effect.provide(Server)),
);

it.live("rejects a commit the repo does not have", () =>
  Effect.gen(function* () {
    const response = yield* postCheck("fixture", {
      commit: "0000000000000000000000000000000000000001",
    });
    assert.deepStrictEqual(response, { _tag: "Rejected", reason: { _tag: "UnknownCommit" } });
  }).pipe(Effect.provide(Server)),
);

it.live("fetches and installs once for two concurrent checks of one commit", () =>
  Effect.gen(function* () {
    const responses = yield* Effect.all(
      [
        checkChange("fixture", { deleted: ["src/bad.ts"] }),
        checkChange("fixture", { files: { "src/c.ts": "export const c = 3;\n" } }),
      ],
      { concurrency: "unbounded" },
    );
    assert.deepStrictEqual(
      responses.map((response) => response._tag === "ActionResult" && response.diagnostics),
      [[], [BAD_TS]],
    );
    const commands = (yield* spawned).map((line) => line.split(" ").slice(0, 2).join(" "));
    assert.deepStrictEqual(
      [
        commands.filter((command) => command === "git fetch").length,
        commands.filter((command) => command === "pnpm install").length,
      ],
      [1, 1],
    );
  }).pipe(Effect.provide(Server)),
);

it.live("sends a repo's token only in its Authorization header, never in output or logs", () =>
  Effect.gen(function* () {
    const response = yield* postCheckRaw("fixture", {
      repo: "test/private",
      commit: "0000000000000000000000000000000000000001",
    });
    const body = yield* response.text;
    const { privateAuthorizations } = yield* Fixtures;
    const header = `Basic ${Buffer.from(`x-access-token:${PRIVATE_TOKEN}`).toString("base64")}`;
    assert.deepStrictEqual(
      { status: response.status, authorizations: [...new Set(privateAuthorizations)] },
      { status: 502, authorizations: [header] },
    );
    assert.match(body, /^git fetch from test\/private failed:\n.*terminal prompts disabled/su);
    const surfaces = [body, ...(yield* spawned), ...(yield* LogLines)].join("\n");
    assert.notInclude(surfaces, PRIVATE_TOKEN);
    assert.notInclude(surfaces, header.slice("Basic ".length));
  }).pipe(Effect.provide(Server)),
);

it.live(
  "fetches a github.com repo with a read token the GitHub App mints for that repo alone",
  () =>
    Effect.gen(function* () {
      const response = yield* postCheck("fixture", { repo: "test/github" });
      assert.deepStrictEqual(response._tag === "ActionResult" && response.diagnostics, [BAD_TS]);
      const { issued } = yield* Fixtures;
      assert.deepStrictEqual(
        issued().map(({ installation, repositories, permissions }) => ({
          installation,
          repositories,
          permissions,
        })),
        [
          {
            installation: 7,
            repositories: ["fixture"],
            permissions: { contents: "read", metadata: "read" },
          },
        ],
      );
      const surfaces = [...(yield* spawned), ...(yield* LogLines)].join("\n");
      for (const { token } of issued()) assert.notInclude(surfaces, token);
    }).pipe(Effect.provide(Server)),
);

it.live("answers 502 for a github.com repo the GitHub App is not installed on", () =>
  Effect.gen(function* () {
    const response = yield* postCheckRaw("fixture", {
      repo: "test/uninstalled",
      commit: "0000000000000000000000000000000000000001",
    });
    assert.deepStrictEqual(
      { status: response.status, body: yield* response.text },
      {
        status: 502,
        body:
          "git fetch from test/uninstalled failed:\nThe GitHub App is not installed on " +
          "test/uninstalled. Install it on the repo to give dorbs access.",
      },
    );
  }).pipe(Effect.provide(Server)),
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
    const check = yield* postCheck("fixture", { files: { "src/a.ts": "a" } });
    assert.deepStrictEqual(check, { _tag: "MissingBlobs", sha256s: [hashOfA] });
  }).pipe(Effect.provide(Server)),
);

it.live("answers 401 on every route without the right bearer token", () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const blob = HttpClientRequest.put(
      "/blobs/ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    ).pipe(HttpClientRequest.bodyText("a"));
    const check = HttpClientRequest.post("/check").pipe(
      HttpClientRequest.bodyText('{"repo":"test/fixture"}', "application/json"),
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
  }).pipe(Effect.provide(Server)),
);

const BUILD_INFO = `${NodeOS.tmpdir()}/typecheck-escape-${NodeCrypto.randomUUID()}.tsbuildinfo`;

it.live(
  "answers 422 before any tool runs when the commit's tsconfig writes outside the check",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const response = yield* postCheckRaw("buildinfo", {});
      assert.deepStrictEqual(
        { status: response.status, body: yield* response.text },
        {
          status: 422,
          body:
            "The commit's tsconfig sets options the service does not run: " +
            "config/base.json: compilerOptions.incremental, " +
            "config/base.json: compilerOptions.tsBuildInfoFile",
        },
      );
      assert.isFalse(yield* fs.exists(BUILD_INFO));
      assert.deepStrictEqual(
        (yield* spawned).filter((line) => !line.startsWith("git ")),
        [],
        "no install and no tool ran",
      );
    }).pipe(
      Effect.provide(
        TestServer({
          buildinfo: {
            "package.json": EMPTY_PACKAGE,
            "tsconfig.json": '{ "extends": "./config/base.json", "include": ["src"] }\n',
            "config/base.json": JSON.stringify({
              compilerOptions: {
                ...JSON.parse(TSCONFIG).compilerOptions,
                incremental: true,
                tsBuildInfoFile: BUILD_INFO,
              },
            }),
            "src/a.ts": "export const a = 1;\n",
          },
        }),
      ),
    ),
);

it.live("refuses a changed file that imports from outside the repo, and runs no tool", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const outside = yield* fs.makeTempDirectoryScoped();
    const secret = `hunter2-${NodeCrypto.randomUUID()}`;
    yield* fs.writeFileString(`${outside}/secret.ts`, `export const SECRET = "${secret}";\n`);
    const ranBefore = (yield* spawned).length;
    const response = yield* checkChange("fixture", {
      files: {
        "src/a.ts": `import { SECRET } from "${outside}/secret.ts";\nconst n: typeof SECRET = 1;\n`,
      },
    });
    assert.deepStrictEqual(response._tag === "ActionResult" && response.diagnostics, [
      {
        tool: ToolName.make("typecheck"),
        path: RelativePath.make("src/a.ts"),
        line: 1,
        column: 25,
        code: "OutsideModule",
        message: `"${outside}/secret.ts" can resolve outside the repo. Import only files in the repo or installed packages.`,
        severity: "error",
      },
    ]);
    assert.notInclude(JSON.stringify(response), secret);
    assert.deepStrictEqual(
      (yield* spawned).slice(ranBefore).filter((line) => line.startsWith("tsrs")),
      [],
    );
  }).pipe(Effect.provide(Server)),
);

it.live("answers 502 when a fetch outlives its deadline, and the next check runs again", () =>
  Effect.gen(function* () {
    const statuses = [];
    for (const _ of [1, 2]) {
      const response = yield* postCheckRaw("fixture", {
        repo: "test/hanging",
        commit: "0000000000000000000000000000000000000001",
      });
      statuses.push({ status: response.status, body: yield* response.text });
    }
    const timedOut = {
      status: 502,
      body: "git fetch from test/hanging failed:\ngit timed out after 500ms",
    };
    assert.deepStrictEqual(statuses, [timedOut, timedOut]);
  }).pipe(Effect.provide(TestServer({ fixture: FIXTURE }, { PROCESS_TIMEOUT: "500 millis" }))),
);

it.live("refuses a check whose program reads a file outside the repo and its packages", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { dataDir } = yield* Fixtures;
    // Module resolution climbs past the check into every ancestor's node_modules.
    const leak = `${dataDir}/../node_modules/leak`;
    const secret = `hunter2-${NodeCrypto.randomUUID()}`;
    yield* fs.makeDirectory(leak, { recursive: true });
    yield* fs.writeFileString(`${leak}/package.json`, '{ "name": "leak", "types": "index.d.ts" }');
    yield* fs.writeFileString(`${leak}/index.d.ts`, `export declare const SECRET: "${secret}";\n`);
    const response = yield* checkChange("fixture", {
      files: { "src/a.ts": 'import { SECRET } from "leak";\nconst n: typeof SECRET = 1;\n' },
    });
    assert.deepStrictEqual(response._tag === "ActionResult" && response.diagnostics, [
      {
        tool: ToolName.make("typecheck"),
        path: RelativePath.make("tsconfig.json"),
        line: 1,
        column: 1,
        code: "OutsideModule",
        message:
          "The program reads a file outside the repo and its installed packages, so the service withholds its diagnostics.",
        severity: "error",
      },
    ]);
    assert.notInclude(JSON.stringify(response), secret);
  }).pipe(Effect.provide(Server)),
);

it.live("answers 413 for a body over 5 MiB and stores nothing", () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const content = "a".repeat(5 * 1024 * 1024 + 1);
    const sha256 = NodeCrypto.createHash("sha256").update(content).digest("hex");
    const response = yield* client.execute(
      HttpClientRequest.put(`/blobs/${sha256}`).pipe(
        HttpClientRequest.bearerToken(TOKEN),
        HttpClientRequest.bodyText(content, "application/octet-stream"),
      ),
    );
    assert.strictEqual(response.status, 413);
    const check = yield* postCheck("fixture", { files: { "src/big.ts": content } });
    assert.deepStrictEqual(check, { _tag: "MissingBlobs", sha256s: [Sha256.make(sha256)] });
  }).pipe(Effect.provide(Server)),
);

// Three lockfiles that differ only in a comment, so each needs its own install.
const lockfileRepo = (n: number) => ({
  "package.json": EMPTY_PACKAGE,
  "pnpm-lock.yaml": `# ${n}\nlockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n`,
  "tsconfig.json": TSCONFIG,
  "src/a.ts": "export const a = 1;\n",
});

it.live("runs at most two installs at once", () =>
  Effect.gen(function* () {
    const responses = yield* Effect.all(
      ["one", "two", "three"].map((fixture) => checkChange(fixture, {})),
      { concurrency: "unbounded" },
    );
    assert.deepStrictEqual(
      responses.map((response) => response._tag === "ActionResult" && response.diagnostics),
      [[], [], []],
    );
    assert.strictEqual((yield* PeakRunning).get("pnpm"), 2);
  }).pipe(
    Effect.provide(
      TestServer({ one: lockfileRepo(1), two: lockfileRepo(2), three: lockfileRepo(3) }),
    ),
  ),
);

it.live("runs the tools once for identical concurrent actions", () =>
  Effect.gen(function* () {
    const change = { files: { "src/d.ts": 'export const d: number = "d";\n' } };
    yield* upload(change.files["src/d.ts"]);
    const responses = yield* Effect.all(
      [1, 2, 3].map(() => postCheck("fixture", change)),
      { concurrency: "unbounded" },
    );
    const D_TS = { ...BAD_TS, path: RelativePath.make("src/d.ts") };
    assert.deepStrictEqual(
      responses.map((response) => response._tag === "ActionResult" && response.diagnostics),
      [
        [BAD_TS, D_TS],
        [BAD_TS, D_TS],
        [BAD_TS, D_TS],
      ],
    );
    assert.lengthOf(
      (yield* spawned).filter((line) => line.startsWith("tsrs --noEmit")),
      1,
    );
  }).pipe(Effect.provide(Server)),
);

it.live("clones the checkout once and lays each check's changes over the same tree", () =>
  Effect.gen(function* () {
    const C_TS = { ...BAD_TS, path: RelativePath.make("src/new/c.ts") };
    const responses = [
      yield* checkChange("fixture", {
        files: {
          "src/a.ts": 'export const a: number = "a";\n',
          "src/new/c.ts": 'export const c: number = "c";\n',
        },
        deleted: ["src/bad.ts"],
      }),
      yield* checkChange("fixture", { files: { "src/e.ts": "export {};\n" } }),
      yield* checkChange("fixture", { deleted: ["src/bad.ts"] }),
    ];
    assert.deepStrictEqual(
      responses.map((response) => response._tag === "ActionResult" && response.diagnostics),
      [[{ ...BAD_TS, path: RelativePath.make("src/a.ts") }, C_TS], [BAD_TS], []],
    );
    const clone = process.platform === "darwin" ? "cp -cR " : "cp -R --reflink=auto ";
    assert.lengthOf(
      (yield* spawned).filter((line) => line.startsWith(clone)),
      1,
    );
  }).pipe(Effect.provide(Server)),
);

it.live("evicts what was used least recently past CACHE_MAX_BYTES, and rebuilds it on demand", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { dataDir, commits } = yield* Fixtures;
    const tree = (name: string) => fs.exists(`${dataDir}/checkouts/test/${name}/${commits[name]}`);
    const diagnosticsOf = (response: ActionResponse) =>
      response._tag === "ActionResult" && {
        diagnostics: response.diagnostics,
        cached: response.cached,
      };
    const first = yield* checkChange("first", {});
    const second = yield* checkChange("second", {});
    // A check evicts before it runs, so the second check removed only what the first left.
    assert.deepStrictEqual([yield* tree("first"), yield* tree("second")], [false, true]);
    const again = yield* checkChange("first", {});
    assert.deepStrictEqual([yield* tree("first"), yield* tree("second")], [true, false]);
    assert.deepStrictEqual([first, second, again].map(diagnosticsOf), [
      { diagnostics: [BAD_TS], cached: false },
      { diagnostics: [], cached: false },
      { diagnostics: [BAD_TS], cached: false },
    ]);
  }).pipe(
    Effect.provide(
      TestServer(
        {
          first: FIXTURE,
          second: {
            "package.json": EMPTY_PACKAGE,
            "tsconfig.json": TSCONFIG,
            "src/a.ts": "export {};\n",
          },
        },
        { CACHE_MAX_BYTES: "1" },
      ),
    ),
  ),
);

// SvelteKit's tests have a route directory named package.json.
it.live("treats only a file named package.json as a manifest", () =>
  Effect.gen(function* () {
    const response = yield* checkChange("routes", {});
    assert.deepStrictEqual(response._tag === "ActionResult" && response.diagnostics, []);
  }).pipe(
    Effect.provide(
      TestServer({
        routes: {
          "package.json": EMPTY_PACKAGE,
          "tsconfig.json": TSCONFIG,
          "src/routes/package.json/page.ts": "export const page = 1;\n",
        },
      }),
    ),
  ),
);

const PATCH = "--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-a\n+b\n";

it.live("installs with the patch files the commit's pnpm config names", () =>
  Effect.gen(function* () {
    const response = yield* checkChange("patched", {});
    assert.deepStrictEqual(response._tag === "ActionResult" && response.diagnostics, []);
  }).pipe(
    Effect.provide(
      TestServer({
        patched: {
          "package.json": EMPTY_PACKAGE,
          "pnpm-workspace.yaml":
            'packages: ["."]\npatchedDependencies:\n  nothing@1.0.0: patches/nothing.patch\n',
          "pnpm-lock.yaml": `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

patchedDependencies:
  nothing@1.0.0: ecca42a505ca8368222ce6cf242af2fa35f9a390cb69a33277731d3fbaef38f0

importers:

  .: {}
`,
          "patches/nothing.patch": PATCH,
          "tsconfig.json": TSCONFIG,
          "src/a.ts": "export const a = 1;\n",
        },
      }),
    ),
  ),
);

it.live(
  "answers 422 for a patch path outside the repo or of pnpm's config, and installs nothing",
  () =>
    Effect.gen(function* () {
      const response = yield* postCheckRaw("escaping", {});
      assert.deepStrictEqual(
        [response.status, (yield* response.text).split("\n").at(-1)],
        [
          422,
          "The commit's pnpm config names patches the service does not stage: a: ../../outside.patch, b: .npmrc",
        ],
      );
      assert.deepStrictEqual(
        (yield* spawned).filter((line) => line.startsWith("pnpm")),
        [],
      );
    }).pipe(
      Effect.provide(
        TestServer({
          escaping: {
            "package.json": EMPTY_PACKAGE,
            "pnpm-workspace.yaml":
              'packages: ["."]\npatchedDependencies:\n  a: ../../outside.patch\n  b: .npmrc\n',
            ".npmrc": "registry=http://127.0.0.1:9/\n",
            "tsconfig.json": TSCONFIG,
            "src/a.ts": "export const a = 1;\n",
          },
        }),
      ),
    ),
);

it.live("answers 422 naming the package manager for a commit that pins another", () =>
  Effect.gen(function* () {
    const response = yield* postCheckRaw("yarn", {});
    assert.deepStrictEqual(
      [response.status, yield* response.text],
      [422, "The commit pins the package manager yarn; the service installs with pnpm only."],
    );
    assert.deepStrictEqual(
      (yield* spawned).filter((line) => line.startsWith("pnpm")),
      [],
    );
  }).pipe(
    Effect.provide(
      TestServer({
        yarn: {
          "package.json": '{ "name": "fixture", "packageManager": "yarn@1.22.22" }\n',
          "tsconfig.json": TSCONFIG,
          "src/a.ts": "export const a = 1;\n",
        },
      }),
    ),
  ),
);
