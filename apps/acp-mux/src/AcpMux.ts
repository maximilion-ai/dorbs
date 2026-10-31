import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";

const MuxConfig = Config.schema(
  Schema.Struct({
    MUX_SOCKET_PATH: Schema.NonEmptyString,
    AGENT_URL: Schema.URLFromString,
    AGENT_TOKEN: Schema.Redacted(Schema.NonEmptyString),
  }),
);

class SocketPathTaken extends Schema.TaggedError<SocketPathTaken>()("SocketPathTaken", {
  path: Schema.String,
  owner: Schema.Literals(["live daemon", "not a socket"]),
}) {
  override get message() {
    return `${this.path} is taken by ${this.owner === "live daemon" ? "a running acp-mux" : "a file that is not a socket"}`;
  }
}

const isListening = (path: string) =>
  Effect.callback<boolean>((resume) => {
    const probe = NodeNet.createConnection({ path });
    probe.once("connect", () => {
      probe.destroy();
      resume(Effect.succeed(true));
    });
    probe.once("error", () => resume(Effect.succeed(false)));
    return Effect.sync(() => probe.destroy());
  });

const claimSocketPath = Effect.fn("AcpMux.claimSocketPath")(function* (path: string) {
  const stat = yield* Effect.promise(() => NodeFSP.lstat(path).catch(() => undefined));
  if (stat === undefined) return;
  if (!stat.isSocket()) yield* new SocketPathTaken({ path, owner: "not a socket" });
  if (yield* isListening(path)) yield* new SocketPathTaken({ path, owner: "live daemon" });
  yield* Effect.promise(() => NodeFSP.unlink(path));
  yield* Effect.logInfo(`removed stale socket ${path}`);
});

const agentEndpoint = (agentUrl: URL, connection: string) => {
  const endpoint = new URL(`${agentUrl.pathname.replace(/\/$/u, "")}/acp`, agentUrl);
  endpoint.searchParams.set("connection", connection);
  return endpoint.href;
};

const relay = Effect.fn("AcpMux.relay")(function* (
  client: Socket.Socket,
  agentUrl: URL,
  agentToken: Redacted.Redacted,
) {
  const connection = NodeCrypto.randomUUID();
  const agent = yield* Socket.makeWebSocket(agentEndpoint(agentUrl, connection), {
    headers: { authorization: `Bearer ${Redacted.value(agentToken)}` },
  });
  // The agent writer waits for the WebSocket to open, so lines read before then queue in order.
  const toAgent = yield* agent.writer;
  const toClient = yield* client.writer;
  const upstream = Socket.toStream(client).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach(toAgent.write),
  );
  const downstream = Effect.gen(function* () {
    const { pull } = yield* agent.reader;
    return yield* pull.pipe(
      Effect.flatMap((messages) => toClient.writeAll(Arr.flatMap(messages, (m) => [m, "\n"]))),
      Effect.forever,
    );
  });
  return yield* Effect.raceFirst(upstream, downstream).pipe(
    Effect.catchTags({
      SocketError: (error) => Effect.logInfo(`connection ${connection} closed: ${error.message}`),
    }),
  );
}, Effect.scoped);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MuxConfig;
    yield* claimSocketPath(config.MUX_SOCKET_PATH);
    const server = yield* NodeSocketServer.make({ path: config.MUX_SOCKET_PATH });
    yield* Effect.forkScoped(
      server.run((client) => relay(client, config.AGENT_URL, config.AGENT_TOKEN)),
    );
    yield* Effect.logInfo(`acp-mux listening on ${config.MUX_SOCKET_PATH}`);
  }),
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS));
