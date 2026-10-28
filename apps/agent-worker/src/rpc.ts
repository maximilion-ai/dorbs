import { encodeFrame, type JsonRpcFrame, type JsonRpcRequest } from "@dorbs/protocol/jsonrpc";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export type RequestId = JsonRpcRequest["id"];

/** The acp-mux connection a frame came in on: its WebSocket's `?connection=` id and its Durable Object's name. */
export const ConnectionId = Schema.NonEmptyString.pipe(Schema.brand("ConnectionId"));
export type ConnectionId = typeof ConnectionId.Type;

export const ErrorCode = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  resourceNotFound: -32002,
} as const;

export class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  code: Schema.Int,
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export const invalidParams = (cause: Schema.SchemaError) =>
  new RpcError({ code: ErrorCode.invalidParams, reason: cause.message });

/** One frame as one WebSocket message, without its line terminator; acp-mux appends the newline on the socket. */
export const toMessage = (frame: JsonRpcFrame): string =>
  Effect.runSync(encodeFrame(frame).pipe(Effect.orDie)).replace(/\n$/u, "");

/** The response to request `id`, from how its handler ended. */
export const responseFrame = (
  id: RequestId,
  outcome: Result.Result<unknown, RpcError>,
): JsonRpcFrame =>
  Result.isSuccess(outcome)
    ? { jsonrpc: "2.0", id, result: outcome.success }
    : {
        jsonrpc: "2.0",
        id,
        error: { code: outcome.failure.code, message: outcome.failure.reason },
      };

/** The name a Durable Object was reached by; both ACP objects are only ever reached through getByName. */
export const nameOf = (ctx: DurableObjectState): string => {
  const { name } = ctx.id;
  if (name === undefined) throw new Error("Expected a Durable Object reached by name");
  return name;
};
