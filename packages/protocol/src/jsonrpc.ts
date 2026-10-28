import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Version = Schema.Literal("2.0");
const RequestId = Schema.Union([Schema.String, Schema.Number]);

const JsonRpcRequest = Schema.Struct({
  jsonrpc: Version,
  id: RequestId,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
export type JsonRpcRequest = typeof JsonRpcRequest.Type;

const JsonRpcNotification = Schema.Struct({
  jsonrpc: Version,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
export type JsonRpcNotification = typeof JsonRpcNotification.Type;

const JsonRpcSuccess = Schema.Struct({
  jsonrpc: Version,
  id: RequestId,
  result: Schema.Unknown,
});
export type JsonRpcSuccess = typeof JsonRpcSuccess.Type;

const JsonRpcError = Schema.Struct({
  jsonrpc: Version,
  // Null when the server could not read the request id, such as on a parse error.
  id: Schema.NullOr(RequestId),
  error: Schema.Struct({
    code: Schema.Int,
    message: Schema.String,
    data: Schema.optionalKey(Schema.Unknown),
  }),
});
export type JsonRpcError = typeof JsonRpcError.Type;

// Members are tried in order and decoding drops unknown keys, so a request must
// be tried before a notification or it would decode as one and lose its id.
export const JsonRpcFrame = Schema.Union([
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccess,
  JsonRpcError,
]);
export type JsonRpcFrame = typeof JsonRpcFrame.Type;

const FrameJson = Schema.fromJsonString(JsonRpcFrame);
const encodeFrameJson = Schema.encodeEffect(FrameJson);

/** Decodes one NDJSON line, with or without its trailing newline. */
export const decodeFrame = Schema.decodeEffect(FrameJson);

/** Encodes one frame as an NDJSON line, trailing newline included. */
export const encodeFrame = (frame: JsonRpcFrame): Effect.Effect<string, Schema.SchemaError> =>
  encodeFrameJson(frame).pipe(Effect.map((json) => `${json}\n`));
