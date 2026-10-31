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
import { RunOutcome, transition, Turn, TurnEvent, type TurnCommand } from "./Turn.ts";

/** The agent loop a session runs on. */
export type HarnessName = "pi" | "opencode";

/**
 * The session as stored: the client's cwd, the agent loop it runs on, the model picked in T3 if any, and the loop's
 * session once the first prompt made one. Sessions made before the choice of loop have no harness and run on Pi.
 */
export type SessionRecord = {
  readonly cwd: string;
  readonly harness?: HarnessName;
  /** A ModelChoice value; the deployment's default when absent. */
  readonly model?: string;
  readonly piSession?: string;
  readonly openCodeSession?: string;
};

export type Emit = (update: Acp.SessionUpdate) => void;

/**
 * A prompt the session took and has not answered yet: the one its turn runs, then any waiting behind it. Kept in
 * storage, so a turn a restart cut off runs on and is answered.
 */
export type OpenPrompt = {
  readonly requestId: RequestId;
  readonly connection: ConnectionId;
  /** The agent loop's id for the run, by which a restarted session finds it again. */
  readonly operationId: string;
  readonly prompt: ReadonlyArray<Acp.ContentBlock>;
  /** Set once its turn began: the prompt is in the history and the loop has it. */
  readonly started?: true;
};

/**
 * One prompt's run in the agent loop. A run a restart cut off is `resumed`: the loop may have it already, and then
 * waits for it and emits what is left of it instead of starting it again.
 */
export type Operation = { readonly id: string; readonly resumed: boolean };

type Streamed = "agent_message_chunk" | "agent_thought_chunk";

/** Streamed text of one kind, joined. */
export type StreamedRun = { readonly sessionUpdate: Streamed; readonly text: string };

/** What one ACP session needs from the Durable Object that hosts it. */
export type SessionHost = {
  readonly sessionId: Acp.SessionId;
  readonly record: () => SessionRecord | undefined;
  readonly saveRecord: (record: SessionRecord) => void;
  /** The connection this session's updates go to. */
  readonly attached: () => ConnectionId | undefined;
  readonly attach: (connection: ConnectionId) => void;
  /** Keeps one session/update message for every later load to replay; streamed text arrives joined into runs. */
  readonly remember: (message: string) => void;
  /** Keeps one chunk of the streamed run in progress, so a restart does not lose what was sent of it. */
  readonly hold: (sessionUpdate: Streamed, text: string) => void;
  /** The streamed run held so far, joined, which the store then forgets. */
  readonly release: () => StreamedRun | undefined;
  readonly prompts: () => ReadonlyArray<OpenPrompt>;
  readonly savePrompts: (prompts: ReadonlyArray<OpenPrompt>) => void;
  /** Sends every kept message to a connection, oldest first, after every message sent before and before any after. */
  readonly replay: (connection: ConnectionId) => void;
  /** Sends one message to a connection, after every message sent before it. */
  readonly send: (connection: ConnectionId, message: string) => void;
  /** The models this session may pick from, the default first, as T3's picker shows them. */
  readonly choices: ReadonlyArray<{ readonly value: string; readonly name: string }>;
  /** Moves the agent loop's session, if it has one yet, to a newly picked model. */
  readonly setModel: (record: SessionRecord) => Promise<void>;
  /** Runs a prompt as `operation` and resolves with how it ended. */
  readonly run: (
    record: SessionRecord,
    prompt: string,
    operation: Operation,
    signal: AbortSignal,
    emit: Emit,
  ) => Promise<RunOutcome>;
};

/** How a request was taken: answered at once, or a prompt its turn answers when it ends. */
type Accepted = Data.TaggedEnum<{
  Answered: { readonly result: unknown };
  Taken: {};
}>;
const Accepted = Data.taggedEnum<Accepted>();

/**
 * The `_meta` key of the `session_info_update` that closes a turn in the history: `{stopReason}`, or `{error}`
 * when the prompt failed. ACP v1 has no update that ends a turn; the prompt's response does that live.
 */
const TURN_ENDED = "dorbs/turnEnded";

const isStreamed = (
  update: Acp.SessionUpdate,
): update is Extract<Acp.SessionUpdate, { sessionUpdate: Streamed }> =>
  update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk";

/** Said in the thread where a turn a restart cut off picks up again. */
export const RESUMED = "\n\n(Restarted; resuming this turn.)\n\n";

/** The most streamed text one history row keeps, in characters; JSON escaping keeps a row well under 2 MB. */
const RUN_CHARS = 32 * 1024;

/** The most one history row keeps, in UTF-8 bytes; a Durable Object's SQLite rows stop at 2 MB. */
const ROW_BYTES = 256 * 1024;

const utf8 = new TextEncoder();

const cut = (value: unknown, max: number): unknown => {
  if (typeof value === "string") {
    return value.length <= max
      ? value
      : `${value.slice(0, max)}\n[… ${value.length - max} more characters not kept in the session history]`;
  }
  if (Array.isArray(value)) return value.map((item) => cut(item, max));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cut(item, max)]));
  }
  return value;
};

/** `encoded`, with its long strings cut and marked until it fits one history row. */
const fitted = (encoded: string): string => {
  let row = encoded;
  for (let max = ROW_BYTES / 4; utf8.encode(row).byteLength > ROW_BYTES && max >= 1024; max /= 2) {
    row = JSON.stringify(cut(JSON.parse(encoded), max));
  }
  return row;
};

const decodeLoad = Schema.decodeUnknownEffect(Acp.LoadSessionRequest);
const decodePrompt = Schema.decodeUnknownEffect(Acp.PromptRequest);
const decodeCancel = Schema.decodeUnknownEffect(Acp.CancelNotification);
const encodeLoadResponse = Schema.encodeEffect(Acp.LoadSessionResponse);
const encodePromptResponse = Schema.encodeEffect(Acp.PromptResponse);
const encodeNotification = Schema.encodeEffect(Acp.SessionNotification);
/** session/set_config_option for a select option; T3 sends the model it picked as `configId: "model"`. */
const decodeSetConfigOption = Schema.decodeUnknownEffect(
  Schema.Struct({ sessionId: Acp.SessionId, configId: Schema.String, value: Schema.String }),
);

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
 * user's prompts and each turn's end are kept in order for the next load to replay. Prompts run one at a time, in
 * the order they came; a turn runs on when its connection drops, and after a restart of its Durable Object.
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

  const message = (update: Acp.SessionUpdate) =>
    encodeNotification({ sessionId: host.sessionId, update }).pipe(
      Effect.map((params) => toMessage({ jsonrpc: "2.0", method: "session/update", params })),
    );

  // Streamed text is kept as one row per run of chunks of one kind, not one per chunk; the host holds the run in
  // progress. A run a restart cut off is still held, and the first flush keeps it.
  let run: { readonly sessionUpdate: Streamed; chars: number } | undefined;

  /** Keeps a message for replay; the reason when the history could not take it. */
  const store = (encoded: string): string | undefined => {
    try {
      host.remember(fitted(encoded));
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const flush = () => {
    run = undefined;
    const held = host.release();
    if (held === undefined) return;
    const { sessionUpdate, text } = held;
    const failed = store(
      Effect.runSync(
        message({ sessionUpdate, content: { type: "text", text } }).pipe(Effect.orDie),
      ),
    );
    if (failed !== undefined) console.error(`Could not keep streamed text for replay: ${failed}`);
  };

  /** Keeps an update for replay and returns the message to send, which says so if a tool's could not be kept. */
  const keep = (update: Acp.SessionUpdate, encoded: string): string => {
    if (isStreamed(update) && update.content.type === "text") {
      const { text } = update.content;
      if (run?.sessionUpdate === update.sessionUpdate && run.chars + text.length <= RUN_CHARS) {
        run.chars += text.length;
        host.hold(update.sessionUpdate, text);
        return encoded;
      }
      flush();
      run = { sessionUpdate: update.sessionUpdate, chars: text.length };
      host.hold(update.sessionUpdate, text);
      return encoded;
    }
    flush();
    const failed = store(encoded);
    if (failed === undefined) return encoded;
    console.error(`Could not keep a ${update.sessionUpdate} for replay: ${failed}`);
    if (!("toolCallId" in update)) return encoded;
    const failure = Effect.runSync(
      message({
        sessionUpdate: "tool_call_update",
        toolCallId: update.toolCallId,
        status: "failed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `The session history could not keep this result: ${failed}`,
            },
          },
        ],
      }).pipe(Effect.orDie),
    );
    store(failure);
    return failure;
  };

  /** Keeps an update for replay and sends it to the attached connection, unless that one is `except`. */
  const publish = (update: Acp.SessionUpdate, except?: ConnectionId) =>
    Effect.runSync(
      message(update).pipe(
        Effect.map((encoded) => {
          const kept = keep(update, encoded);
          const attached = host.attached();
          if (attached !== undefined && attached !== except) host.send(attached, kept);
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

  /** T3 fills its model picker from a select option in the model category. */
  const configOptions = (record: SessionRecord): ReadonlyArray<Acp.SessionConfigOption> => {
    const offered = host.choices.some((choice) => choice.value === record.model);
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue:
          offered && record.model !== undefined ? record.model : (host.choices[0]?.value ?? ""),
        options: host.choices.map(({ value, name }) => ({ value, name })),
      },
    ];
  };

  const load = Effect.fn("Session.load")(function* (connection: ConnectionId, params: unknown) {
    yield* decodeLoad(params).pipe(Effect.mapError(invalidParams));
    const record = yield* stored;
    host.attach(connection);
    flush();
    host.replay(connection);
    return Accepted.Answered({
      result: yield* encodeLoadResponse({ configOptions: configOptions(record) }).pipe(
        Effect.orDie,
      ),
    });
  });

  /** A model picked in T3: the next turn runs on it, as the rest of the session does. */
  const setConfigOption = Effect.fn("Session.setConfigOption")(function* (params: unknown) {
    const { configId, value } = yield* decodeSetConfigOption(params).pipe(
      Effect.mapError(invalidParams),
    );
    if (configId !== "model" || !host.choices.some((choice) => choice.value === value)) {
      return yield* new RpcError({
        code: ErrorCode.invalidParams,
        reason: `No ${configId} option ${value}; offered: ${host.choices.map((choice) => choice.value).join(", ")}`,
      });
    }
    const record = { ...(yield* stored), model: value };
    host.saveRecord(record);
    yield* Effect.promise(() => host.setModel(record));
    return Accepted.Answered({ result: { configOptions: configOptions(record) } });
  });

  const answer = (open: OpenPrompt, end: Result.Result<Acp.PromptResponse, RpcError>) =>
    host.send(
      open.connection,
      toMessage(
        responseFrame(
          open.requestId,
          Result.map(end, (response) =>
            Effect.runSync(encodePromptResponse(response).pipe(Effect.orDie)),
          ),
        ),
      ),
    );

  /**
   * Runs one prompt's turn to its end and answers it. The requester knows its own prompt and gets the response, so
   * only another attached connection is told of either.
   */
  const runTurn = Effect.fn("Session.turn")(function* (taken: OpenPrompt) {
    const abort = new AbortController();
    const started = step(TurnEvent.Prompt({ requestId: taken.requestId, abort }));
    let open = taken;
    const operation = { id: open.operationId, resumed: open.started !== undefined };
    if (Result.isSuccess(started) && !operation.resumed) {
      for (const content of open.prompt) {
        publish({ sessionUpdate: "user_message_chunk", content }, open.connection);
      }
      open = { ...open, started: true };
      host.savePrompts([open, ...host.prompts().slice(1)]);
    } else if (Result.isSuccess(started)) {
      // The loop may repeat what it was saying when the restart cut it off; this marks where.
      publish({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: RESUMED } });
    }
    const record = host.record();
    // A loop that throws ends the turn as failed, so the prompt is still answered.
    const outcome = yield* Result.isFailure(started)
      ? Effect.succeed(RunOutcome.Failed({ reason: started.failure.reason }))
      : record === undefined
        ? Effect.succeed(RunOutcome.Failed({ reason: `Unknown session ${host.sessionId}` }))
        : Effect.tryPromise({
            try: () =>
              host.run(record, promptText(open.prompt), operation, abort.signal, (update) =>
                publish(update),
              ),
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed(
                RunOutcome.Failed({
                  reason: error instanceof Error ? error.message : String(error),
                }),
              ),
            ),
          );
    const end = Result.flatMap(step(TurnEvent.Finish({ outcome })), ending);
    publish(turnEnded(end), open.connection);
    host.savePrompts(host.prompts().slice(1));
    answer(open, end);
  });

  // Whether a fiber is running the open prompts; set and cleared in the same tick as the prompts are read.
  let driving = false;

  const drive: Effect.Effect<void> = Effect.suspend(() => {
    const [next] = host.prompts();
    if (next === undefined) {
      driving = false;
      return Effect.void;
    }
    return runTurn(next).pipe(
      // A turn that breaks outside the loop, as on a storage error, still answers its prompt and lets the next run.
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          turn = Turn.Idle();
          host.savePrompts(host.prompts().slice(1));
          answer(
            next,
            Result.fail(
              new RpcError({
                code: ErrorCode.internal,
                reason: defect instanceof Error ? defect.message : String(defect),
              }),
            ),
          );
        }),
      ),
      Effect.andThen(drive),
    );
  });

  // Settles once no open prompt is left to run.
  let drained: Promise<void> = Promise.resolve();

  /** Runs the open prompts, oldest first, unless they are running already; the first may be one a restart cut off. */
  const resume = () => {
    if (driving || host.prompts().length === 0) return;
    driving = true;
    drained = Effect.runPromise(drive);
  };

  const prompt = Effect.fn("Session.prompt")(function* (
    connection: ConnectionId,
    requestId: RequestId,
    params: unknown,
  ) {
    const request = yield* decodePrompt(params).pipe(Effect.mapError(invalidParams));
    yield* stored;
    yield* attachedTo(connection);
    // A client that sends a prompt while a turn runs, as T3 does right after a reconnect, waits for that turn.
    host.savePrompts([
      ...host.prompts(),
      { requestId, connection, operationId: crypto.randomUUID(), prompt: request.prompt },
    ]);
    resume();
    return Accepted.Taken();
  });

  /** A cancel ends the running turn as cancelled and answers every prompt waiting behind it the same way. */
  const cancel = () => {
    void step(TurnEvent.Cancel());
    const [running, ...waiting] = host.prompts();
    if (running === undefined || waiting.length === 0) return;
    host.savePrompts([running]);
    for (const open of waiting) answer(open, Result.succeed({ stopReason: "cancelled" }));
  };

  const requests = new Map<
    string,
    (connection: ConnectionId, id: RequestId, params: unknown) => Effect.Effect<Accepted, RpcError>
  >([
    ["session/load", (connection, _id, params) => load(connection, params)],
    ["session/prompt", prompt],
    ["session/set_config_option", (_connection, _id, params) => setConfigOption(params)],
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
          Effect.map(cancel),
          Effect.catchTags({
            SchemaError: (error) => Effect.logWarning("Ignored session/cancel", error),
            RpcError: (error) => Effect.logWarning("Ignored session/cancel", error),
          }),
        ),
    ],
  ]);

  /** session/new: creates the session the first time, attaches the connection that asked, and offers its models. */
  const open = (connection: ConnectionId, cwd: string): ReadonlyArray<Acp.SessionConfigOption> => {
    const record = host.record() ?? { cwd };
    if (host.record() === undefined) host.saveRecord(record);
    host.attach(connection);
    return configOptions(record);
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
              Taken: () => Effect.void,
            }),
      ),
      Effect.withSpan("Session.receive"),
    );
  };

  return { open, receive, resume, drained: () => drained };
};
