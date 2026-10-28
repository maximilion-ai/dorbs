import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";

import * as AcpMux from "./AcpMux.ts";

const TOKEN = "test-token";

interface AgentSocket {
  readonly connection: string | null;
  readonly authorization: string | undefined;
  readonly received: Queue.Queue<string>;
  readonly send: (message: string) => Effect.Effect<void, Socket.SocketError>;
  readonly closeFromAgent: Effect.Effect<void, Socket.SocketError>;
  readonly closed: Deferred.Deferred<void>;
}

const startAgent = Effect.fn("test.startAgent")(function* (options?: {
  readonly holdHandshakes: boolean;
}) {
  const accepted = yield* Queue.unbounded<AgentSocket>();
  const handshakes = yield* Queue.unbounded<Effect.Effect<void>>();
  const server = yield* NodeSocketServer.makeWebSocket({
    host: "127.0.0.1",
    port: 0,
    verifyClient: (_info, accept) => {
      if (options?.holdHandshakes === true) {
        Queue.offerUnsafe(
          handshakes,
          Effect.sync(() => accept(true)),
        );
      } else {
        accept(true);
      }
    },
  });
  yield* Effect.forkScoped(
    server.run((socket) =>
      Effect.gen(function* () {
        // `run` provides the upgrade request, but its handler type does not say so.
        const request = Option.getOrThrow(
          yield* Effect.serviceOption(NodeSocketServer.IncomingMessage),
        );
        const { pull } = yield* socket.reader;
        const writer = yield* socket.writer;
        const received = yield* Queue.unbounded<string>();
        const closed = yield* Deferred.make<void>();
        Queue.offerUnsafe(accepted, {
          connection: new URL(request.url ?? "/", "ws://agent").searchParams.get("connection"),
          authorization: request.headers.authorization,
          received,
          send: writer.write,
          closeFromAgent: writer.write(new Socket.CloseEvent(1000)),
          closed,
        });
        yield* pull.pipe(
          Effect.flatMap((messages) =>
            Queue.offerAll(
              received,
              messages.map((m) => (typeof m === "string" ? m : new TextDecoder().decode(m))),
            ),
          ),
          Effect.forever,
          Effect.ignore,
        );
        yield* Deferred.succeed(closed, undefined);
      }).pipe(Effect.scoped),
    ),
  );
  const port = "port" in server.address ? server.address.port : 0;
  return { url: `ws://127.0.0.1:${port}`, accepted, handshakes };
});

const tempSocketPath = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-mux-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
).pipe(Effect.map((dir) => NodePath.join(dir, "mux.sock")));

const muxLayer = (socketPath: string, agentUrl: string) =>
  AcpMux.layer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          MUX_SOCKET_PATH: socketPath,
          AGENT_URL: agentUrl,
          AGENT_TOKEN: TOKEN,
        }),
      ),
    ),
  );

interface Client {
  readonly write: (text: string) => Effect.Effect<void>;
  readonly lines: Queue.Queue<string>;
  readonly output: () => string;
  readonly close: Effect.Effect<void>;
  readonly closed: Deferred.Deferred<void>;
}

const client = Effect.fn("test.client")(function* (
  input: NodeStream.Writable,
  output: NodeStream.Readable,
  onClosed: (done: () => void) => void,
  close: () => void,
) {
  const lines = yield* Queue.unbounded<string>();
  const closed = yield* Deferred.make<void>();
  let text = "";
  let partial = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    text += chunk;
    const parts = (partial + chunk).split("\n");
    partial = parts.pop() ?? "";
    Queue.offerAllUnsafe(lines, parts);
  });
  onClosed(() => Deferred.doneUnsafe(closed, Exit.void));
  yield* Effect.addFinalizer(() => Effect.sync(close));
  return {
    write: (data: string) => Effect.sync(() => void input.write(data)),
    lines,
    output: () => text,
    close: Effect.sync(close),
    closed,
  } satisfies Client;
});

const ncClient = (socketPath: string) => {
  const nc = NodeChildProcess.spawn("/usr/bin/nc", ["-U", socketPath], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  return client(
    nc.stdin,
    nc.stdout,
    (done) => nc.once("exit", done),
    () => nc.kill(),
  );
};

const netClient = (socketPath: string) => {
  const socket = NodeNet.createConnection({ path: socketPath });
  return client(
    socket,
    socket,
    (done) => socket.once("close", done),
    () => socket.destroy(),
  );
};

const setup = Effect.fn("test.setup")(function* (options?: { readonly holdHandshakes: boolean }) {
  const socketPath = yield* tempSocketPath;
  const agent = yield* startAgent(options);
  yield* Layer.build(muxLayer(socketPath, agent.url));
  return { socketPath, agent };
});

it.live("delivers a line written before the WebSocket opened, first and intact", () =>
  Effect.gen(function* () {
    const { socketPath, agent } = yield* setup({ holdHandshakes: true });
    const nc = yield* netClient(socketPath);
    yield* nc.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    const acceptHandshake = yield* Queue.take(agent.handshakes);
    yield* acceptHandshake;
    const socket = yield* Queue.take(agent.accepted);
    yield* nc.write('{"jsonrpc":"2.0","id":2,"method":"session/new"}\n');
    assert.deepStrictEqual(yield* Queue.takeN(socket.received, 2), [
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      '{"jsonrpc":"2.0","id":2,"method":"session/new"}',
    ]);
  }),
);

it.live("sends a multi-line burst as one WebSocket message per line, in order", () =>
  Effect.gen(function* () {
    const { socketPath, agent } = yield* setup();
    const nc = yield* ncClient(socketPath);
    yield* nc.write('{"n":1}\n{"n":2}\n{"n":3}\n');
    const socket = yield* Queue.take(agent.accepted);
    assert.deepStrictEqual(yield* Queue.takeN(socket.received, 3), [
      '{"n":1}',
      '{"n":2}',
      '{"n":3}',
    ]);
  }),
);

it.live("writes each WebSocket message to the socket with a trailing newline", () =>
  Effect.gen(function* () {
    const { socketPath, agent } = yield* setup();
    const nc = yield* ncClient(socketPath);
    const socket = yield* Queue.take(agent.accepted);
    yield* socket.send('{"id":1,"result":{}}');
    yield* socket.send('{"method":"session/update"}');
    assert.deepStrictEqual(yield* Queue.takeN(nc.lines, 2), [
      '{"id":1,"result":{}}',
      '{"method":"session/update"}',
    ]);
    assert.strictEqual(nc.output(), '{"id":1,"result":{}}\n{"method":"session/update"}\n');
  }),
);

it.live("dials with the bearer token and a distinct connection id per socket", () =>
  Effect.gen(function* () {
    const { socketPath, agent } = yield* setup();
    yield* ncClient(socketPath);
    yield* netClient(socketPath);
    const [first, second] = yield* Queue.takeN(agent.accepted, 2);
    assert.strictEqual(first?.authorization, "Bearer test-token");
    assert.strictEqual(second?.authorization, "Bearer test-token");
    assert.match(first?.connection ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/u);
    assert.match(second?.connection ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/u);
    assert.notStrictEqual(first?.connection, second?.connection);
  }),
);

it.live("closes the WebSocket when nc exits, and the socket when the agent closes", () =>
  Effect.gen(function* () {
    const { socketPath, agent } = yield* setup();
    const leaving = yield* ncClient(socketPath);
    const leavingSocket = yield* Queue.take(agent.accepted);
    yield* leaving.close;
    yield* Deferred.await(leavingSocket.closed);

    const staying = yield* ncClient(socketPath);
    const closingSocket = yield* Queue.take(agent.accepted);
    yield* closingSocket.closeFromAgent;
    yield* Deferred.await(staying.closed);
    assert.strictEqual(staying.output(), "");
  }),
);

it.live("keeps two concurrent sockets on their own WebSockets", () =>
  Effect.gen(function* () {
    const { socketPath, agent } = yield* setup();
    const a = yield* ncClient(socketPath);
    const b = yield* netClient(socketPath);
    const sockets = yield* Queue.takeN(agent.accepted, 2);
    yield* Effect.forEach(
      sockets,
      (socket) =>
        Queue.take(socket.received).pipe(
          Effect.flatMap((message) => socket.send(`echo ${message}`)),
          Effect.forever,
          Effect.forkScoped,
        ),
      { discard: true },
    );
    yield* Effect.all([a.write("a1\na2\n"), b.write("b1\nb2\n"), a.write("a3\n"), b.write("b3\n")]);
    const [fromA, fromB] = yield* Effect.all([Queue.takeN(a.lines, 3), Queue.takeN(b.lines, 3)], {
      concurrency: 2,
    });
    assert.deepStrictEqual(fromA, ["echo a1", "echo a2", "echo a3"]);
    assert.deepStrictEqual(fromB, ["echo b1", "echo b2", "echo b3"]);
  }),
);

it.live("shutdown closes every pair and removes the socket file", () =>
  Effect.gen(function* () {
    const socketPath = yield* tempSocketPath;
    const agent = yield* startAgent();
    const muxScope = yield* Scope.make();
    yield* Layer.buildWithScope(muxLayer(socketPath, agent.url), muxScope);
    const nc = yield* ncClient(socketPath);
    const socket = yield* Queue.take(agent.accepted);
    assert.strictEqual(NodeFS.existsSync(socketPath), true);
    yield* Scope.close(muxScope, Exit.void);
    yield* Deferred.await(socket.closed);
    yield* Deferred.await(nc.closed);
    assert.strictEqual(NodeFS.existsSync(socketPath), false);
  }),
);

it.live("replaces a stale socket file and refuses a path a live mux owns", () =>
  Effect.gen(function* () {
    const socketPath = yield* tempSocketPath;
    NodeChildProcess.execFileSync(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.exit(0))`,
    ]);
    assert.strictEqual(NodeFS.lstatSync(socketPath).isSocket(), true);
    const agent = yield* startAgent();
    yield* Layer.build(muxLayer(socketPath, agent.url));
    yield* ncClient(socketPath);
    const socket = yield* Queue.take(agent.accepted);
    assert.strictEqual(socket.authorization, "Bearer test-token");

    const error = yield* Layer.build(muxLayer(socketPath, agent.url)).pipe(Effect.flip);
    assert.strictEqual(error.message, `${socketPath} is taken by a running acp-mux`);
  }),
);
