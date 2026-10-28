import type { StopReason } from "@dorbs/protocol/acp";
import type { JsonRpcRequest } from "@dorbs/protocol/jsonrpc";
import * as Data from "effect/Data";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

type RequestId = JsonRpcRequest["id"];

/** Where one ACP session's prompt stands. */
export type Turn = Data.TaggedEnum<{
  Idle: {};
  Prompting: { readonly requestId: RequestId; readonly abort: AbortController };
  Cancelling: { readonly requestId: RequestId };
}>;
export const Turn = Data.taggedEnum<Turn>();

/** How a Pi run ended, before a cancel can override it. */
export type RunOutcome = Data.TaggedEnum<{
  Answered: {};
  Aborted: {};
  Failed: { readonly reason: string };
}>;
export const RunOutcome = Data.taggedEnum<RunOutcome>();

export type TurnEvent = Data.TaggedEnum<{
  Prompt: { readonly requestId: RequestId; readonly abort: AbortController };
  Cancel: {};
  Finish: { readonly outcome: RunOutcome };
}>;
export const TurnEvent = Data.taggedEnum<TurnEvent>();

/** What the connection does once the session has moved. */
export type TurnCommand = Data.TaggedEnum<{
  None: {};
  Abort: { readonly abort: AbortController };
  Reply: { readonly requestId: RequestId; readonly stopReason: StopReason };
  Fail: { readonly requestId: RequestId; readonly reason: string };
}>;
export const TurnCommand = Data.taggedEnum<TurnCommand>();

class SessionBusy extends Schema.TaggedError<SessionBusy>()("SessionBusy", {
  requestId: Schema.Union([Schema.String, Schema.Number]),
}) {
  override get message(): string {
    return `Prompt ${this.requestId} is still running in this session`;
  }
}

class NoOpenPrompt extends Schema.TaggedError<NoOpenPrompt>()("NoOpenPrompt", {}) {
  override get message(): string {
    return "A run finished in a session with no open prompt";
  }
}

type Step = Result.Result<readonly [Turn, TurnCommand], SessionBusy | NoOpenPrompt>;

const move = (turn: Turn, command: TurnCommand = TurnCommand.None()): Step =>
  Result.succeed([turn, command]);

const busy = (running: RequestId): Step => Result.fail(new SessionBusy({ requestId: running }));

const settle = (requestId: RequestId, outcome: RunOutcome): TurnCommand =>
  RunOutcome.$match(outcome, {
    Answered: () => TurnCommand.Reply({ requestId, stopReason: "end_turn" }),
    Aborted: () => TurnCommand.Reply({ requestId, stopReason: "cancelled" }),
    Failed: ({ reason }) => TurnCommand.Fail({ requestId, reason }),
  });

/** The one transition table for a session's turn. */
export const transition = (turn: Turn, event: TurnEvent): Step =>
  Turn.$match(turn, {
    Idle: () =>
      TurnEvent.$match(event, {
        Prompt: ({ requestId, abort }) => move(Turn.Prompting({ requestId, abort })),
        Cancel: () => move(turn),
        Finish: () => Result.fail(new NoOpenPrompt()),
      }),
    Prompting: ({ requestId, abort }) =>
      TurnEvent.$match(event, {
        Prompt: () => busy(requestId),
        Cancel: () => move(Turn.Cancelling({ requestId }), TurnCommand.Abort({ abort })),
        Finish: ({ outcome }) => move(Turn.Idle(), settle(requestId, outcome)),
      }),
    // A cancel wins over however the run ended, so T3's open prompt always resolves "cancelled".
    Cancelling: ({ requestId }) =>
      TurnEvent.$match(event, {
        Prompt: () => busy(requestId),
        Cancel: () => move(turn),
        Finish: () => move(Turn.Idle(), TurnCommand.Reply({ requestId, stopReason: "cancelled" })),
      }),
  });
