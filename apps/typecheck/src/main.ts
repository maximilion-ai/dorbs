import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";

import * as App from "./Http.ts";

const Server = NodeHttpServer.layerConfig(NodeHttp.createServer, {
  port: Config.Port("PORT").pipe(Config.withDefault(8080)),
});

HttpRouter.serve(App.layer).pipe(
  Layer.provide([Server, NodeServices.layer]),
  Layer.launch,
  NodeRuntime.runMain,
);
