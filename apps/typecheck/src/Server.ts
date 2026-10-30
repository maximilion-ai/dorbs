import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Config from "effect/Config";

/** The HTTP server on HOST:PORT. HOST defaults to loopback, so only this machine reaches it. */
export const layer = NodeHttpServer.layerConfig(NodeHttp.createServer, {
  host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Port("PORT").pipe(Config.withDefault(8080)),
});
