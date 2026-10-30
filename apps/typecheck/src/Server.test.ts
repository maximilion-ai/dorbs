import * as NodeNet from "node:net";

import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";

import * as Server from "./Server.ts";

const freePort = Effect.callback<number>((resume) => {
  const server = NodeNet.createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() =>
      resume(Effect.succeed(typeof address === "object" && address !== null ? address.port : 0)),
    );
  });
});

const listeningOn = Effect.fn("test.listeningOn")(
  function* (_env: Record<string, string>) {
    return HttpServer.formatAddress((yield* HttpServer.HttpServer).address);
  },
  (effect, env) =>
    effect.pipe(
      Effect.provide(
        Server.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))),
      ),
    ),
);

it.live("listens on loopback only unless HOST says otherwise", () =>
  Effect.gen(function* () {
    const port = String(yield* freePort);
    assert.deepStrictEqual(
      [yield* listeningOn({ PORT: port }), yield* listeningOn({ PORT: port, HOST: "0.0.0.0" })],
      [`http://127.0.0.1:${port}`, `http://0.0.0.0:${port}`],
    );
  }),
);
