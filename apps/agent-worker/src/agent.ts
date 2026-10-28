import * as Acp from "@dorbs/protocol/acp";
import {
  decodeFrame,
  encodeFrame,
  type JsonRpcFrame,
  type JsonRpcRequest,
} from "@dorbs/protocol/jsonrpc";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { transition, Turn, TurnEvent, type RunOutcome, type TurnCommand } from "./Turn.ts";

type RequestId = JsonRpcRequest["id"];

/** One ACP session as stored: the client's cwd, and the Pi session once the first prompt made one. */
export type SessionRecord = { readonly cwd: string; readonly piSession?: string };

export type Emit = (update: Acp.SessionUpdate) => void;

/** What the ACP agent needs from the Durable Object that hosts it. */
export type AgentHost = {
  readonly newSessionId: () => string;
  readonly loadSession: (sessionId: string) => SessionRecord | undefined;
  readonly saveSession: (sessionId: string, record: SessionRecord) => void;
  readonly run: (
    sessionId: string,
    record: SessionRecord,
    prompt: string,
    signal: AbortSignal,
    emit: Emit,
  ) => Promise<RunOutcome>;
};

const ErrorCode = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  resourceNotFound: -32002,
} as const;

class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  code: Schema.Int,
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

// Advertises nothing T3 would act on beyond prompting: no load, resume, fork, list, auth, fs, or terminal.
const INITIALIZE: Acp.InitializeResponse = {
  protocolVersion: 1,
  agentInfo: { name: "dorbs", version: "0.1.0" },
  agentCapabilities: {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
  },
  authMethods: [],
};

const decodeNewSession = Schema.decodeUnknownEffect(Acp.NewSessionRequest);
const decodePrompt = Schema.decodeUnknownEffect(Acp.PromptRequest);
const decodeCancel = Schema.decodeUnknownEffect(Acp.CancelNotification);
const encodeInitialize = Schema.encodeEffect(Acp.InitializeResponse);
const encodeNewSession = Schema.encodeEffect(Acp.NewSessionResponse);
const encodePromptResponse = Schema.encodeEffect(Acp.PromptResponse);
const encodeNotification = Schema.encodeEffect(Acp.SessionNotification);

const invalidParams = (cause: Schema.SchemaError) =>
  new RpcError({ code: ErrorCode.invalidParams, reason: cause.message });

const promptText = (blocks: ReadonlyArray<Acp.ContentBlock>): string =>
  blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");

/**
 * The ACP v1 agent for one connection. `handle` takes one JSON-RPC line and answers through `send`.
 * Turns live in memory: a run never outlives the instance, so after a restart every session is Idle.
 */
export const makeAgent = (host: AgentHost) => {
  const turns = new Map<string, Turn>();

  const step = (sessionId: string, event: TurnEvent): Result.Result<TurnCommand, RpcError> => {
    const moved = transition(turns.get(sessionId) ?? Turn.Idle(), event);
    if (Result.isFailure(moved)) {
      return Result.fail(
        new RpcError({ code: ErrorCode.invalidRequest, reason: moved.failure.message }),
      );
    }
    const [turn, command] = moved.success;
    if (turn._tag === "Idle") turns.delete(sessionId);
    else turns.set(sessionId, turn);
    if (command._tag === "Abort") command.abort.abort();
    return Result.succeed(command);
  };

  const session = (sessionId: string) => {
    const record = host.loadSession(sessionId);
    return record === undefined
      ? Effect.fail(
          new RpcError({
            code: ErrorCode.resourceNotFound,
            reason: `Unknown session ${sessionId}`,
          }),
        )
      : Effect.succeed(record);
  };

  const notify =
    (send: (line: string) => void, sessionId: string): Emit =>
    (update) =>
      Effect.runSync(
        encodeNotification({ sessionId, update }).pipe(
          Effect.flatMap((params) =>
            encodeFrame({ jsonrpc: "2.0", method: "session/update", params }),
          ),
          Effect.map(send),
          Effect.catchTags({
            SchemaError: (error) => Effect.logError("Dropped an invalid session/update", error),
          }),
        ),
      );

  const prompt = Effect.fn("Agent.prompt")(function* (
    requestId: RequestId,
    params: Acp.PromptRequest,
    send: (line: string) => void,
  ) {
    const record = yield* session(params.sessionId);
    const abort = new AbortController();
    yield* Effect.fromResult(step(params.sessionId, TurnEvent.Prompt({ requestId, abort })));
    const outcome = yield* Effect.promise(() =>
      host.run(
        params.sessionId,
        record,
        promptText(params.prompt),
        abort.signal,
        notify(send, params.sessionId),
      ),
    );
    const command = yield* Effect.fromResult(step(params.sessionId, TurnEvent.Finish({ outcome })));
    if (command._tag === "Reply") return { stopReason: command.stopReason };
    return yield* new RpcError({
      code: ErrorCode.internal,
      reason: command._tag === "Fail" ? command.reason : `Unexpected ${command._tag} after a run`,
    });
  });

  const requests = new Map<
    string,
    (
      id: RequestId,
      params: unknown,
      send: (line: string) => void,
    ) => Effect.Effect<unknown, RpcError>
  >([
    ["initialize", () => encodeInitialize(INITIALIZE).pipe(Effect.orDie)],
    [
      "session/new",
      (_id, params) =>
        decodeNewSession(params).pipe(
          Effect.mapError(invalidParams),
          Effect.map(({ cwd }) => {
            const sessionId = host.newSessionId();
            host.saveSession(sessionId, { cwd });
            return { sessionId };
          }),
          Effect.flatMap((response) => encodeNewSession(response).pipe(Effect.orDie)),
        ),
    ],
    [
      "session/prompt",
      (id, params, send) =>
        decodePrompt(params).pipe(
          Effect.mapError(invalidParams),
          Effect.flatMap((request) => prompt(id, request, send)),
          Effect.flatMap((response) => encodePromptResponse(response).pipe(Effect.orDie)),
        ),
    ],
  ]);

  const notifications = new Map<string, (params: unknown) => Effect.Effect<void>>([
    [
      "session/cancel",
      (params) =>
        decodeCancel(params).pipe(
          Effect.map(({ sessionId }) => void step(sessionId, TurnEvent.Cancel())),
          Effect.catchTags({
            SchemaError: (error) => Effect.logWarning("Ignored session/cancel", error),
          }),
        ),
    ],
  ]);

  const write = (send: (line: string) => void, frame: JsonRpcFrame) =>
    encodeFrame(frame).pipe(Effect.map(send), Effect.orDie);

  const errorFrame = (id: RequestId | null, error: RpcError): JsonRpcFrame => ({
    jsonrpc: "2.0",
    id,
    error: { code: error.code, message: error.reason },
  });

  const dispatch = (frame: JsonRpcFrame, send: (line: string) => void): Effect.Effect<void> => {
    // A response: this agent sends no requests, so there is nothing to match it to.
    if (!("method" in frame)) return Effect.void;
    if (!("id" in frame)) return notifications.get(frame.method)?.(frame.params) ?? Effect.void;
    const request =
      requests.get(frame.method) ??
      (() =>
        Effect.fail(
          new RpcError({
            code: ErrorCode.methodNotFound,
            reason: `Unknown method ${frame.method}`,
          }),
        ));
    return Effect.result(request(frame.id, frame.params, send)).pipe(
      Effect.flatMap((outcome) =>
        write(
          send,
          Result.isSuccess(outcome)
            ? { jsonrpc: "2.0", id: frame.id, result: outcome.success }
            : errorFrame(frame.id, outcome.failure),
        ),
      ),
    );
  };

  const handle = (line: string, send: (line: string) => void) =>
    decodeFrame(line).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          write(
            send,
            errorFrame(null, new RpcError({ code: ErrorCode.parse, reason: error.message })),
          ),
        onSuccess: (frame) => dispatch(frame, send),
      }),
      Effect.withSpan("Agent.handle"),
    );

  /** Cancels every running prompt, as when the client hangs up. */
  const cancelAll = () => {
    for (const sessionId of turns.keys()) step(sessionId, TurnEvent.Cancel());
  };

  return { handle, cancelAll };
};
