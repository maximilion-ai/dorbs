import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";

import {
  ActionResponse,
  CommitSha,
  RelativePath,
  RepoId,
  Sha256,
  ToolchainId,
} from "@dorbs/protocol/typecheck";

import { type FixtureFile, makeRepo } from "../../../scripts/gitFixture.ts";
import * as App from "./Http.ts";

export const TOKEN = "test-token";
/** The read token of test/private, which must never leave the service except in its header. */
export const PRIVATE_TOKEN = "private-token-6f1c2a";

/** Every command line the service spawned, in order. */
export class SpawnLog extends Context.Service<SpawnLog, Ref.Ref<ReadonlyArray<string>>>()(
  "dorbs/typecheck/test/SpawnLog",
) {}

/** Every line the service logged. */
export class LogLines extends Context.Service<LogLines, Array<string>>()(
  "dorbs/typecheck/test/LogLines",
) {}

/**
 * The commit of each fixture repo, registered as test/<name> with a file:// url, and the
 * Authorization headers that test/private's server received. That server refuses every request.
 */
export class Fixtures extends Context.Service<
  Fixtures,
  {
    readonly commits: Readonly<Record<string, CommitSha>>;
    readonly privateAuthorizations: ReadonlyArray<string>;
    readonly dataDir: string;
  }
>()("dorbs/typecheck/test/Fixtures") {}

const RecordingSpawner = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const log = yield* SpawnLog;
    return ChildProcessSpawner.make((command) =>
      Ref.update(log, (lines) => [
        ...lines,
        command._tag === "StandardCommand" ? [command.command, ...command.args].join(" ") : "pipe",
      ]).pipe(Effect.andThen(spawner.spawn(command))),
    );
  }),
);

const refusingServer = Effect.acquireRelease(
  Effect.callback<{ readonly server: NodeHttp.Server; readonly authorizations: string[] }>(
    (resume) => {
      const authorizations: string[] = [];
      const server = NodeHttp.createServer((request, response) => {
        authorizations.push(request.headers.authorization ?? "");
        response.writeHead(401, { "www-authenticate": 'Basic realm="test"' }).end();
      });
      server.listen(0, "127.0.0.1", () => {
        resume(Effect.succeed({ server, authorizations }));
      });
    },
  ),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
);

const FixtureConfig = (repos: Readonly<Record<string, Record<string, FixtureFile>>>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const commits = Object.fromEntries(
        Object.entries(repos).map(([name, files]) => [
          name,
          CommitSha.make(makeRepo(`${dir}/${name}.git`, files)),
        ]),
      );
      const refusing = yield* refusingServer;
      const address = refusing.server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      yield* fs.writeFileString(
        `${dir}/repos.json`,
        JSON.stringify([
          ...Object.keys(repos).map((name) => ({
            id: `test/${name}`,
            url: `file://${dir}/${name}.git`,
          })),
          {
            id: "test/private",
            url: `http://127.0.0.1:${port}/private.git`,
            tokenEnv: "PRIVATE_TOKEN",
          },
        ]),
      );
      return Layer.mergeAll(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            DATA_DIR: `${dir}/data`,
            TYPECHECK_TOKEN: TOKEN,
            REPOS_FILE: `${dir}/repos.json`,
            PRIVATE_TOKEN,
          }),
        ),
        Layer.succeed(Fixtures, {
          commits,
          privateAuthorizations: refusing.authorizations,
          dataDir: `${dir}/data`,
        }),
      );
    }),
  );

const CapturedLogs = Layer.unwrap(
  Effect.sync(() => {
    const lines: string[] = [];
    return Layer.mergeAll(
      Layer.succeed(LogLines, lines),
      Logger.layer([
        Logger.make(({ message, cause }) => {
          lines.push(`${String(message)} ${Cause.pretty(cause)}`);
        }),
      ]),
    );
  }),
);

/** The real routes on a random port, a client pointed at them, and these repos registered. */
export const TestServer = (repos: Readonly<Record<string, Record<string, FixtureFile>>>) =>
  HttpRouter.serve(App.layer, { disableLogger: true }).pipe(
    Layer.provide(RecordingSpawner),
    Layer.provideMerge(FixtureConfig(repos)),
    Layer.provideMerge(Layer.effect(SpawnLog, Ref.make<ReadonlyArray<string>>([]))),
    Layer.provideMerge(CapturedLogs),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(NodeServices.layer),
  );

const sha256Of = (content: string) =>
  Sha256.make(NodeCrypto.createHash("sha256").update(content).digest("hex"));

const authorized = HttpClientRequest.bearerToken(TOKEN);
const decodeActionResponse = HttpClientResponse.schemaBodyJson(ActionResponse);

const TOOLCHAIN = ToolchainId.make("node26-tsrs0.20-oxlint1.89");

export const upload = Effect.fn("test.upload")(function* (content: string) {
  const client = yield* HttpClient.HttpClient;
  const sha256 = sha256Of(content);
  const response = yield* client.execute(
    HttpClientRequest.put(`/blobs/${sha256}`).pipe(
      authorized,
      HttpClientRequest.bodyText(content, "application/octet-stream"),
    ),
  );
  if (response.status !== 204) {
    return yield* Effect.die(new Error(`upload returned ${response.status}`));
  }
  return sha256;
});

export type Change = {
  readonly toolchain?: string;
  readonly repo?: string;
  readonly commit?: string;
  readonly files?: Record<string, string>;
  readonly deleted?: ReadonlyArray<string>;
};

/** Posts a check of `change` against test/<fixture> at its commit, and answers the raw response. */
export const postCheckRaw = Effect.fn("test.postCheckRaw")(function* (
  fixture: string,
  change: Change,
) {
  const client = yield* HttpClient.HttpClient;
  const { commits } = yield* Fixtures;
  return yield* client.execute(
    HttpClientRequest.post("/actions").pipe(
      authorized,
      HttpClientRequest.bodyJsonUnsafe({
        kind: "check",
        toolchain: change.toolchain ?? TOOLCHAIN,
        repo: RepoId.make(change.repo ?? `test/${fixture}`),
        commit: change.commit ?? commits[fixture],
        files: Object.entries(change.files ?? {}).map(([path, content]) => ({
          path: RelativePath.make(path),
          sha256: sha256Of(content),
        })),
        deleted: (change.deleted ?? []).map((path) => RelativePath.make(path)),
      }),
    ),
  );
});

export const postCheck = Effect.fn("test.postCheck")(function* (fixture: string, change: Change) {
  return yield* decodeActionResponse(yield* postCheckRaw(fixture, change));
});

/** Uploads the changed files, then checks them. */
export const checkChange = Effect.fn("test.checkChange")(function* (
  fixture: string,
  change: Change,
) {
  yield* Effect.forEach(Object.values(change.files ?? {}), upload, { concurrency: "unbounded" });
  return yield* postCheck(fixture, change);
});

export const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    lib: ["es2022"],
    module: "nodenext",
    target: "es2022",
  },
  include: ["src"],
});

export const EMPTY_PACKAGE = '{\n  "name": "fixture",\n  "private": true\n}\n';
