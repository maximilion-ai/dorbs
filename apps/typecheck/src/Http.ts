import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { CheckRequest, CheckResponse, Sha256 } from "@dorbs/protocol/typecheck";

import * as BlobStore from "./BlobStore.ts";
import * as Checker from "./Checker.ts";
import * as Installs from "./Installs.ts";
import * as ServiceConfig from "./ServiceConfig.ts";

const BlobParams = Schema.Struct({ sha256: Sha256 });
const encodeCheckResponse = HttpServerResponse.schemaJson(CheckResponse);

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
        return yield* app;
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
      "/check",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.schemaBodyJson(CheckRequest);
        return yield* encodeCheckResponse(yield* checker.check(request)).pipe(Effect.orDie);
      }).pipe(
        Effect.catchTags({
          SchemaError: (error) =>
            Effect.succeed(HttpServerResponse.text(error.message, { status: 400 })),
          InstallFailed: (error) =>
            Effect.succeed(HttpServerResponse.text(error.message, { status: 422 })),
        }),
      ),
    );
  }),
);

/** The routes with every service they use; needs a platform and a config provider. */
export const layer = routes.pipe(
  Layer.provide(
    Checker.layer.pipe(
      Layer.provideMerge(Installs.layer),
      Layer.provideMerge(BlobStore.layer),
      Layer.provideMerge(ServiceConfig.layer),
    ),
  ),
);
