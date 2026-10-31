import * as NodeCrypto from "node:crypto";

import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { CheckRequest, CheckResponse, TestRequest, TestResponse } from "@dorbs/protocol/checker";

import * as Checker from "./Checker.ts";
import * as Docker from "./Docker.ts";
import * as Environments from "./Environments.ts";
import * as Git from "./Git.ts";
import * as ServiceConfig from "./ServiceConfig.ts";

const encodeCheck = HttpServerResponse.schemaJson(CheckResponse);
const encodeTest = HttpServerResponse.schemaJson(TestResponse);

// A change carries whole files; a session's changes fit easily.
const MAX_BODY = ByteSize.mebibytes(16);

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest();

const text = (status: number) => (error: { readonly message: string }) =>
  Effect.succeed(HttpServerResponse.text(error.message, { status }));

const routes = HttpRouter.use(
  Effect.fn("Http.routes")(function* (router) {
    const checker = yield* Checker.Checker;
    const environments = yield* Environments.Environments;
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
      "POST",
      "/check",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.schemaBodyJson(CheckRequest);
        return yield* encodeCheck(yield* checker.check(request)).pipe(Effect.orDie);
      }).pipe(
        Effect.catchTags({
          SchemaError: text(400),
          FetchFailed: text(502),
          ImageMissing: text(503),
        }),
      ),
    );

    yield* router.add(
      "POST",
      "/test",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.schemaBodyJson(TestRequest);
        return yield* encodeTest(yield* checker.test(request)).pipe(Effect.orDie);
      }).pipe(
        Effect.catchTags({
          SchemaError: text(400),
          FetchFailed: text(502),
          ImageMissing: text(503),
        }),
      ),
    );

    yield* router.add(
      "GET",
      "/environments",
      Effect.map(environments.list, (list) => HttpServerResponse.jsonUnsafe(list)),
    );
  }),
);

/** The routes with every service they use; needs a platform and a config provider. */
export const layer = routes.pipe(
  Layer.provide(
    Checker.layer.pipe(
      Layer.provideMerge(Environments.layer),
      Layer.provideMerge(Layer.mergeAll(Docker.layer, Git.layer)),
      Layer.provideMerge(ServiceConfig.layer),
    ),
  ),
);
