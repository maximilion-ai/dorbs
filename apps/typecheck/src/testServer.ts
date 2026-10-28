import * as NodeCrypto from "node:crypto";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";

import { CheckResponse, RelativePath, Sha256 } from "@dorbs/protocol/typecheck";

import * as App from "./Http.ts";

export const TOKEN = "test-token";

/** Every command line the service spawned, in order. */
export class SpawnLog extends Context.Service<SpawnLog, Ref.Ref<ReadonlyArray<string>>>()(
  "dorbs/typecheck/test/SpawnLog",
) {}

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

const FreshConfig = Layer.unwrap(
  Effect.gen(function* () {
    const dataDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    return ConfigProvider.layer(
      ConfigProvider.fromUnknown({ DATA_DIR: dataDir, TYPECHECK_TOKEN: TOKEN }),
    );
  }),
);

/** The real routes on a random port, a client pointed at them, and a fresh DATA_DIR. */
export const TestServer = HttpRouter.serve(App.layer, { disableLogger: true }).pipe(
  Layer.provide(FreshConfig),
  Layer.provide(RecordingSpawner),
  Layer.provideMerge(Layer.effect(SpawnLog, Ref.make<ReadonlyArray<string>>([]))),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(NodeServices.layer),
);

const sha256Of = (content: string) =>
  Sha256.make(NodeCrypto.createHash("sha256").update(content).digest("hex"));

const authorized = HttpClientRequest.bearerToken(TOKEN);
const decodeCheckResponse = HttpClientResponse.schemaBodyJson(CheckResponse);

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

export const postCheck = Effect.fn("test.postCheck")(function* (
  lockfile: string,
  files: Record<string, string>,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.post("/check").pipe(
      authorized,
      HttpClientRequest.bodyJsonUnsafe({
        lockfile: sha256Of(lockfile),
        files: Object.entries(files).map(([path, content]) => ({
          path: RelativePath.make(path),
          sha256: sha256Of(content),
        })),
      }),
    ),
  );
  return yield* decodeCheckResponse(response);
});

/** Uploads the lockfile and every file, then checks them. */
export const checkProject = Effect.fn("test.checkProject")(function* (
  lockfile: string,
  files: Record<string, string>,
) {
  yield* Effect.forEach([lockfile, ...Object.values(files)], upload, { concurrency: "unbounded" });
  return yield* postCheck(lockfile, files);
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

export const EMPTY_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}
`;
