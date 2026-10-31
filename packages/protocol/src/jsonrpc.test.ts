import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Acp from "./acp.ts";
import { decodeFrame, encodeFrame } from "./jsonrpc.ts";

// Captured from T3 Code 125b619 by running effect-acp's AcpClient.initialize with
// the client capabilities from provider-acp's adapter.ts.
const T3_INITIALIZE_LINE =
  '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":2,"info":{"name":"t3-code","version":"0.0.0"},"capabilities":{"elicitation":{"form":{}}},"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"elicitation":{"form":{}}},"clientInfo":{"name":"t3-code","version":"0.0.0"}},"id":1073741824,"traceId":"a895982fd0f222068500d20ac5e4f5e4","spanId":"2715004bf08acd5c","sampled":true}\n';

const decodeInitializeRequest = Schema.decodeUnknownEffect(Acp.InitializeRequest);
const encodeSessionNotification = Schema.encodeEffect(Acp.SessionNotification);
const decodeSessionNotification = Schema.decodeUnknownEffect(Acp.SessionNotification);

it.effect("decodes the initialize request T3 Code sends", () =>
  Effect.gen(function* () {
    const frame = yield* decodeFrame(T3_INITIALIZE_LINE);
    assert.deepStrictEqual(frame, {
      jsonrpc: "2.0",
      id: 1073741824,
      method: "initialize",
      params: {
        protocolVersion: 2,
        info: { name: "t3-code", version: "0.0.0" },
        capabilities: { elicitation: { form: {} } },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: { form: {} },
        },
        clientInfo: { name: "t3-code", version: "0.0.0" },
      },
    });

    const params = yield* decodeInitializeRequest("params" in frame ? frame.params : undefined);
    assert.strictEqual(params.protocolVersion, 2);
    assert.deepStrictEqual(params.clientInfo, { name: "t3-code", version: "0.0.0" });
    assert.deepStrictEqual(params.clientCapabilities?.fs, {
      readTextFile: false,
      writeTextFile: false,
    });
  }),
);

it.effect("encodes a diff tool_call_update as the line T3 Code reads", () =>
  Effect.gen(function* () {
    const params = yield* encodeSessionNotification({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "/Users/max/project/src/a.ts",
            oldText: "export const a = 1;\n",
            newText: "export const a = 2;\n",
          },
        ],
      },
    });
    const line = yield* encodeFrame({ jsonrpc: "2.0", method: "session/update", params });

    assert.strictEqual(
      line,
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed","content":[{"type":"diff","path":"/Users/max/project/src/a.ts","oldText":"export const a = 1;\\n","newText":"export const a = 2;\\n"}]}}}\n',
    );

    const echoed = yield* decodeFrame(line);
    const notification = yield* decodeSessionNotification(
      "params" in echoed ? echoed.params : undefined,
    );
    assert.deepStrictEqual(notification.update, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "/Users/max/project/src/a.ts",
          oldText: "export const a = 1;\n",
          newText: "export const a = 2;\n",
        },
      ],
    });
  }),
);

it.effect("keeps a request id and tells responses from errors", () =>
  Effect.gen(function* () {
    assert.strictEqual(
      yield* encodeFrame({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: {} }),
      '{"jsonrpc":"2.0","id":7,"method":"session/prompt","params":{}}\n',
    );
    assert.deepStrictEqual(
      yield* decodeFrame('{"jsonrpc":"2.0","id":7,"result":{"stopReason":"cancelled"}}'),
      { jsonrpc: "2.0", id: 7, result: { stopReason: "cancelled" } },
    );
    assert.deepStrictEqual(
      yield* decodeFrame(
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}',
      ),
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
    );
  }),
);

it.effect("rejects a line that is not JSON-RPC 2.0", () =>
  Effect.gen(function* () {
    const error = yield* decodeFrame('{"jsonrpc":"1.0","method":"initialize"}').pipe(Effect.flip);
    assert.strictEqual(error._tag, "SchemaError");
  }),
);
