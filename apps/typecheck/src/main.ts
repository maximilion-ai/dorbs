import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";

import * as App from "./Http.ts";
import * as Server from "./Server.ts";

HttpRouter.serve(App.layer).pipe(
  Layer.provide([Server.layer, NodeServices.layer]),
  Layer.launch,
  NodeRuntime.runMain,
);
