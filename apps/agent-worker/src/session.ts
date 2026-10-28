import * as Acp from "@dorbs/protocol/acp";
import type { JsonRpcNotification, JsonRpcRequest } from "@dorbs/protocol/jsonrpc";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  ErrorCode,
  invalidParams,
  responseFrame,
  RpcError,
  toMessage,
  type ConnectionId,
  type RequestId,
} from "./rpc.ts";
import { transition, Turn, TurnEvent, type RunOutcome, type TurnCommand } from "./Turn.ts";

/** The session as stored: the client's cwd, and the Pi session once the first prompt made one. */
export type SessionRecord = { readonly cwd: string; readonly piSession?: string };

export type Emit = (update: Acp.SessionUpdate) => void;

/** What one ACP session needs from the Durable Object that hosts it. */
export type SessionHost = {
  readonly sessionId: Acp.SessionId;
  readonly record: () => SessionRecord | undefined;
  readonly saveRecord: (record: SessionRecord) => void;
  /** The connection this session's updates go to. */
  readonly attached: () => ConnectionId | undefined;
  readonly attach: (connection: ConnectionId) => void;
  /** Keeps one session/update message for every later load to replay. */
  readonly remember: (message: string) => void;
  /** Every kept message, oldest first. */
  readonly history: () => ReadonlyArray<string>;
  /** Sends one message to a connection, after every message sent before it. */
  readonly send: (connection: ConnectionId, message: string) => void;
  readonly run: (
    record: SessionRecord,
    prompt: string,
    signal: AbortSignal,
    emit: Emit,
  ) => Promise<RunOutcome>;
};

/** How a request was taken: answered at once, or the start of a turn that answers it when it ends. */
type Accepted = Data.TaggedEnum<{
  Answered: { readonly result: unknown };
  Started: { readonly ended: Effect.Effect<unknown, RpcError> };
}>;
const Accepted = Data.taggedEnum<Accepted>();

/**
 * The `_meta` key of the `session_info_update` that closes a turn in the history: `{stopReason}`, or `{error}`
 * when the prompt failed. ACP v1 has no update that ends a turn; the prompt's response does that live.
 */
const TURN_ENDED = "dorbs/turnEnded";

const decodeLoad = Schema.decodeUnknownEffect(Acp.LoadSessionRequest);
const decodePrompt = Schema.decodeUnknownEffect(Acp.PromptRequest);
const decodeCancel = Schema.decodeUnknownEffect(Acp.CancelNotification);
const encodeLoadResponse = Schema.encodeEffect(Acp.LoadSessionResponse);
const encodePromptResponse = Schema.encodeEffect(Acp.PromptResponse);
const encodeNotification = Schema.encodeEffect(Acp.SessionNotification);

const promptText = (blocks: ReadonlyArray<Acp.ContentBlock>): string =>
  blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");

const ending = (command: TurnCommand): Result.Result<Acp.PromptResponse, RpcError> =>
  command._tag === "Reply"
    ? Result.succeed({ stopReason: command.stopReason })
    : Result.fail(
        new RpcError({
          code: ErrorCode.internal,
          reason:
            command._tag === "Fail" ? command.reason : `Unexpected ${command._tag} after a run`,
        }),
      );

const turnEnded = (end: Result.Result<Acp.PromptResponse, RpcError>): Acp.SessionUpdate => ({
  sessionUpdate: "session_info_update",
  _meta: {
    [TURN_ENDED]: Result.isSuccess(end)
      ? { stopReason: end.success.stopReason }
      : { error: end.failure.reason },
  },
});

/**
 * One ACP v1 session, attached to at most one connection; a session/load moves it to the loader. Updates, the
 * user's prompts and each turn's end are kept in order for the next load to replay. A turn lives in memory and
 * runs on when its connection drops.
 */
export const makeSession = (host: SessionHost) => {
  let turn: Turn = Turn.Idle();

  const step = (event: TurnEvent): Result.Result<TurnCommand, RpcError> => {
    const moved = transition(turn, event);
    if (Result.isFailure(moved)) {
      return Result.fail(
        new RpcError({ code: ErrorCode.invalidRequest, reason: moved.failure.message }),
      );
    }
    const [next, command] = moved.success;
    turn = next;
    if (command._tag === "Abort") command.abort.abort();
    return Result.succeed(command);
  };

  /** Keeps an update for replay and sends it to the attached connection, unless that one is `except`. */
  const publish = (update: Acp.SessionUpdate, except?: ConnectionId) =>
    Effect.runSync(
      encodeNotification({ sessionId: host.sessionId, update }).pipe(
        Effect.map((params) => {
          const message = toMessage({ jsonrpc: "2.0", method: "session/update", params });
          host.remember(message);
          const attached = host.attached();
          if (attached !== undefined && attached !== except) host.send(attached, message);
        }),
        Effect.catchTags({
          SchemaError: (error) => Effect.logError("Dropped an invalid session/update", error),
        }),
      ),
    );

  const stored = Effect.suspend(() => {
    const record = host.record();
    return record === undefined
      ? Effect.fail(
          new RpcError({
            code: ErrorCode.resourceNotFound,
            reason: `Unknown session ${host.sessionId}`,
          }),
        )
      : Effect.succeed(record);
  });

  const attachedTo = (connection: ConnectionId) =>
    Effect.suspend(() =>
      host.attached() === connection
        ? Effect.void
        : Effect.fail(
            new RpcError({
              code: ErrorCode.invalidRequest,
              reason: `Session ${host.sessionId} is attached to another connection. Send session/load to attach this one.`,
            }),
          ),
    );

  const load = Effect.fn("Session.load")(function* (connection: ConnectionId, params: unknown) {
    yield* decodeLoad(params).pipe(Effect.mapError(invalidParams));
    yield* stored;
    host.attach(connection);
    for (const message of host.history()) host.send(connection, message);
    return Accepted.Answered({ result: yield* encodeLoadResponse({}).pipe(Effect.orDie) });
  });

  // The requester knows its own prompt and gets the response, so only another attached connection is told.
  const finish = (connection: ConnectionId, run: Effect.Effect<RunOutcome>) =>
    run.pipe(
      Effect.flatMap((outcome) => Effect.fromResult(step(TurnEvent.Finish({ outcome })))),
      Effect.flatMap((command) => {
        const end = ending(command);
        publish(turnEnded(end), connection);
        return Effect.fromResult(end);
      }),
      Effect.flatMap((response) => encodePromptResponse(response).pipe(Effect.orDie)),
    );

  const prompt = Effect.fn("Session.prompt")(function* (
    connection: ConnectionId,
    requestId: RequestId,
    params: unknown,
  ) {
    const request = yield* decodePrompt(params).pipe(Effect.mapError(invalidParams));
    const record = yield* stored;
    yield* attachedTo(connection);
    const abort = new AbortController();
    yield* Effect.fromResult(step(TurnEvent.Prompt({ requestId, abort })));
    for (const content of request.prompt) {
      publish({ sessionUpdate: "user_message_chunk", content }, connection);
    }
    const run = Effect.promise(() =>
      host.run(record, promptText(request.prompt), abort.signal, (update) => publish(update)),
    );
    return Accepted.Started({ ended: finish(connection, run) });
  });

  const requests = new Map<
    string,
    (connection: ConnectionId, id: RequestId, params: unknown) => Effect.Effect<Accepted, RpcError>
  >([
    ["session/load", (connection, _id, params) => load(connection, params)],
    ["session/prompt", prompt],
  ]);

  const notifications = new Map<
    string,
    (connection: ConnectionId, params: unknown) => Effect.Effect<void>
  >([
    [
      "session/cancel",
      (connection, params) =>
        decodeCancel(params).pipe(
          Effect.andThen(attachedTo(connection)),
          Effect.map(() => void step(TurnEvent.Cancel())),
          Effect.catchTags({
            SchemaError: (error) => Effect.logWarning("Ignored session/cancel", error),
            RpcError: (error) => Effect.logWarning("Ignored session/cancel", error),
          }),
        ),
    ],
  ]);

  /** session/new: creates the session the first time and attaches the connection that asked. */
  const open = (connection: ConnectionId, cwd: string) => {
    if (host.record() === undefined) host.saveRecord({ cwd });
    host.attach(connection);
  };

  /**
   * Takes one frame from a connection and completes once the frame is accepted, so frames are taken in the order
   * the connection sends them. A response goes to the connection that sent the request, when it is ready.
   */
  const receive = (
    connection: ConnectionId,
    frame: JsonRpcRequest | JsonRpcNotification,
  ): Effect.Effect<void> => {
    if (!("id" in frame))
      return notifications.get(frame.method)?.(connection, frame.params) ?? Effect.void;
    const respond = (outcome: Result.Result<unknown, RpcError>) =>
      host.send(connection, toMessage(responseFrame(frame.id, outcome)));
    const request =
      requests.get(frame.method) ??
      (() =>
        Effect.fail(
          new RpcError({
            code: ErrorCode.methodNotFound,
            reason: `Unknown method ${frame.method}`,
          }),
        ));
    return Effect.result(request(connection, frame.id, frame.params)).pipe(
      Effect.flatMap((accepted) =>
        Result.isFailure(accepted)
          ? Effect.sync(() => respond(accepted))
          : Accepted.$match(accepted.success, {
              Answered: ({ result }) => Effect.sync(() => respond(Result.succeed(result))),
              Started: ({ ended }) =>
                Effect.asVoid(Effect.forkDetach(Effect.map(Effect.result(ended), respond))),
            }),
      ),
      Effect.withSpan("Session.receive"),
    );
  };

  return { open, receive };
};
