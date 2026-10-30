import * as NodeCrypto from "node:crypto";

import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { Action, ActionResponse, Sha256 } from "@dorbs/protocol/typecheck";

import * as ActionCache from "./ActionCache.ts";
import * as BlobStore from "./BlobStore.ts";
import * as Checker from "./Checker.ts";
import * as Checkouts from "./Checkouts.ts";
import * as Installs from "./Installs.ts";
import * as ServiceConfig from "./ServiceConfig.ts";
import * as Storage from "./Storage.ts";

const BlobParams = Schema.Struct({ sha256: Sha256 });
const encodeActionResponse = HttpServerResponse.schemaJson(ActionResponse);

// A source file or an action's file list fits easily; the service reads no larger body.
const MAX_BODY = ByteSize.mebibytes(5);

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest();

const routes = HttpRouter.use(
  Effect.fn("Http.routes")(function* (router) {
    const blobs = yield* BlobStore.BlobStore;
    const checker = yield* Checker.Checker;
    const expected = digest(`Bearer ${Redacted.value((yield* ServiceConfig.ServiceConfig).token)}`);

    yield* router.addGlobalMiddleware((app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const presented = digest(request.headers.authorization ?? "");
        if (!NodeCrypto.timingSafeEqual(presented, expected)) {
          return HttpServerResponse.empty({ status: 401 });
        }
        return yield* app.pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, MAX_BODY));
      }),
    );

    yield* router.add(
      "PUT",
      "/blobs/:sha256",
      Effect.gen(function* () {
        const { sha256 } = yield* HttpRouter.schemaPathParams(BlobParams);
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* blobs.put(sha256, new Uint8Array(yield* request.arrayBuffer));
        return HttpServerResponse.empty({ status: 204 });
      }).pipe(
        Effect.catchTags({
          SchemaError: (error) =>
            Effect.succeed(HttpServerResponse.text(error.message, { status: 400 })),
          BlobHashMismatch: (error) =>
            Effect.succeed(HttpServerResponse.text(error.message, { status: 422 })),
        }),
      ),
    );

    yield* router.add(
      "POST",
      "/actions",
      Effect.gen(function* () {
        const action = yield* HttpServerRequest.schemaBodyJson(Action);
        return yield* encodeActionResponse(yield* checker.run(action)).pipe(Effect.orDie);
      }).pipe(
        Effect.catchTags({
          SchemaError: (error) =>
            Effect.succeed(HttpServerResponse.text(error.message, { status: 400 })),
          InstallFailed: (error) =>
            Effect.succeed(HttpServerResponse.text(error.message, { status: 422 })),
          UnsafeConfig: (error) =>
            Effect.succeed(HttpServerResponse.text(error.message, { status: 422 })),
          FetchFailed: (error) =>
            Effect.succeed(HttpServerResponse.text(error.message, { status: 502 })),
        }),
      ),
    );
  }),
);

/** The routes with every service they use; needs a platform and a config provider. */
export const layer = routes.pipe(
  Layer.provide(
    Checker.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(ActionCache.layer, Checkouts.layer, Installs.layer)),
      Layer.provideMerge(BlobStore.layer),
      Layer.provideMerge(Storage.layer),
      Layer.provideMerge(ServiceConfig.layer),
    ),
  ),
);
