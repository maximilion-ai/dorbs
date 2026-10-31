import * as Acp from "@dorbs/protocol/acp";
import { decodeFrame, type JsonRpcFrame } from "@dorbs/protocol/jsonrpc";
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ConnectionId,
  ErrorCode,
  invalidParams,
  nameOf,
  responseFrame,
  RpcError,
  toMessage,
} from "./rpc.ts";

// Advertises loadSession, which replays a session's history; nothing else T3 would act on beyond prompting.
const INITIALIZE: Acp.InitializeResponse = {
  protocolVersion: 1,
  agentInfo: { name: "dorbs", version: "0.1.0" },
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
  },
  authMethods: [],
};

const encodeInitialize = Schema.encodeEffect(Acp.InitializeResponse);
const decodeNewSession = Schema.decodeUnknownEffect(Acp.NewSessionRequest);
const encodeNewSession = Schema.encodeEffect(Acp.NewSessionResponse);

const sessionOf = Schema.decodeUnknownOption(Schema.Struct({ sessionId: Acp.SessionId }));

/**
 * One acp-mux connection: a hibernatable WebSocket carrying JSON-RPC lines. It answers `initialize`, creates
 * sessions on `session/new`, and hands every frame that names a session to that session's AcpSession, which
 * answers through `deliver`.
 */
export class AcpConnection extends DurableObject {
  readonly connection = ConnectionId.make(nameOf(this.ctx));

  #inbox = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const line = typeof message === "string" ? message : new TextDecoder().decode(message);
    const send = (frame: JsonRpcFrame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(toMessage(frame));
    };
    // A session takes each frame before the next is read, so a cancel never overtakes its prompt.
    const handled = this.#inbox.then(() => Effect.runPromise(this.handle(line, send)));
    this.#inbox = handled.catch((error: unknown) => console.error("Dropped a frame", error));
    await handled;
  }

  // Sessions keep running their prompts after the client hangs up; a later session/load replays them.
  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // workerd leaves the close handshake to us; 1005 and 1006 are reserved and cannot be sent back.
    ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  }

  /** Sends messages from a session to this connection's client, one WebSocket message each, if the client is still there. */
  deliver(messages: ReadonlyArray<string>): void {
    for (const ws of this.ctx.getWebSockets()) {
      for (const message of messages) {
        if (ws.readyState === WebSocket.OPEN) ws.send(message);
      }
    }
  }

  private readonly requests = new Map<
    string,
    (params: unknown) => Effect.Effect<unknown, RpcError>
  >([
    ["initialize", () => encodeInitialize(INITIALIZE).pipe(Effect.orDie)],
    [
      "session/new",
      (params) =>
        decodeNewSession(params).pipe(
          Effect.mapError(invalidParams),
          Effect.flatMap(({ cwd }) => {
            const sessionId = crypto.randomUUID();
            return Effect.promise(() =>
              this.env.AcpSession.getByName(sessionId).open(this.connection, cwd),
            ).pipe(Effect.map((configOptions) => ({ sessionId, configOptions })));
          }),
          Effect.flatMap((response) => encodeNewSession(response).pipe(Effect.orDie)),
        ),
    ],
  ]);

  private route(frame: JsonRpcFrame, send: (frame: JsonRpcFrame) => void): Effect.Effect<void> {
    // A response: no session sends requests yet.
    if (!("method" in frame)) return Effect.void;
    const scoped = sessionOf(frame.params);
    if (Option.isSome(scoped)) {
      return Effect.promise(() =>
        this.env.AcpSession.getByName(scoped.value.sessionId).receive(this.connection, frame),
      );
    }
    if (!("id" in frame)) return Effect.void;
    const request =
      this.requests.get(frame.method) ??
      (() =>
        Effect.fail(
          new RpcError({
            code: ErrorCode.methodNotFound,
            reason: `Unknown method ${frame.method}`,
          }),
        ));
    return Effect.result(request(frame.params)).pipe(
      Effect.map((outcome) => send(responseFrame(frame.id, outcome))),
    );
  }

  private handle(line: string, send: (frame: JsonRpcFrame) => void) {
    return decodeFrame(line).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.sync(() =>
            send({
              jsonrpc: "2.0",
              id: null,
              error: { code: ErrorCode.parse, message: error.message },
            }),
          ),
        onSuccess: (frame) => this.route(frame, send),
      }),
      Effect.withSpan("AcpConnection.handle"),
    );
  }
}
