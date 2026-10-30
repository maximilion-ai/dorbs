import type { SessionUpdate } from "@dorbs/protocol/acp";
import type { OpenCodeSessionEvent } from "agents/harness/opencode";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isJsonObject } from "./tools.ts";
import { toolCall, toolCallEnd } from "./updates.ts";

/** Characters already sent of each text and reasoning part of the messages in flight, by part. */
export type Streamed = ReadonlyMap<string, number>;
export const NOTHING_STREAMED: Streamed = new Map();

type Mapped = readonly [Streamed, ReadonlyArray<SessionUpdate>];

type Part = "text" | "reasoning";

const key = (messageId: string, part: Part, ordinal: number) => `${messageId}/${part}/${ordinal}`;

const chunk = (part: Part, text: string): SessionUpdate => ({
  sessionUpdate: part === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk",
  content: { type: "text", text },
});

/**
 * Maps one OpenCode session event to the ACP session updates it produces, as `toSessionUpdates` does Pi's.
 * `details` gives a finished call's `details`, which OpenCode's events do not carry. Paths are reported under the
 * client cwd.
 */
export const toOpenCodeUpdates = (
  before: Streamed,
  event: OpenCodeSessionEvent,
  cwd: string,
  details: (toolCallId: string) => unknown,
): Mapped => {
  switch (event.type) {
    case "text_delta":
    case "reasoning_delta": {
      const part = event.type === "text_delta" ? "text" : "reasoning";
      const at = key(event.messageId, part, event.ordinal);
      const sent = new Map(before);
      sent.set(at, (sent.get(at) ?? 0) + event.delta.length);
      return [sent, event.delta === "" ? [] : [chunk(part, event.delta)]];
    }
    // A part's end carries its whole text; send what the deltas did not.
    case "text_end":
    case "reasoning_end": {
      const part = event.type === "text_end" ? "text" : "reasoning";
      const at = key(event.messageId, part, event.ordinal);
      const from = before.get(at) ?? 0;
      const sent = new Map(before);
      sent.set(at, Math.max(from, event.text.length));
      return [sent, event.text.length > from ? [chunk(part, event.text.slice(from))] : []];
    }
    case "message_end":
      return [new Map([...before].filter(([at]) => !at.startsWith(`${event.messageId}/`))), []];
    case "tool_start":
      return [
        before,
        [toolCall(event.toolCallId, event.name, isJsonObject(event.input) ? event.input : {}, cwd)],
      ];
    case "tool_end":
      return [
        before,
        [
          toolCallEnd(
            event.toolCallId,
            event.error,
            event.output === "" ? [] : [event.output],
            details(event.toolCallId),
            cwd,
          ),
        ],
      ];
    default:
      return [before, []];
  }
};

const Message = { assistantMessageID: Schema.String };

/** The durable events a turn's session updates come from; OpenCode's SDK leaves their type unknown here. */
const LogEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("session.tool.input.started"),
    data: Schema.Struct({ id: Schema.String, name: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("session.tool.called"),
    data: Schema.Struct({
      ...Message,
      id: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("session.tool.success"),
    data: Schema.Struct({
      ...Message,
      id: Schema.String,
      content: Schema.optional(
        Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
      ),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("session.tool.failed"),
    data: Schema.Struct({
      ...Message,
      id: Schema.String,
      error: Schema.Struct({ message: Schema.String }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literals(["session.text.ended", "session.reasoning.ended"]),
    data: Schema.Struct({ ...Message, ordinal: Schema.Number, text: Schema.String }),
  }),
]);
const decodeLogEvent = Schema.decodeUnknownOption(LogEvent);

const isEnqueued = Schema.is(
  Schema.Struct({
    type: Schema.Literal("session.inbox.enqueued"),
    data: Schema.Struct({ inboxID: Schema.String }),
  }),
);

/** Whether a durable event is the input of `operationId` reaching OpenCode, whose id agents' harness makes `msg_<id>`. */
export const startsTurn = (logged: unknown, operationId: string): boolean =>
  isEnqueued(logged) && logged.data.inboxID === `msg_${operationId}`;

/**
 * The event `session.events()` reports for one of OpenCode's durable events, for those that make session updates.
 * `names` keeps each tool call's name from its input, which the call itself leaves out.
 */
export const fromLog = (
  names: Map<string, string>,
  logged: unknown,
): OpenCodeSessionEvent | undefined => {
  const decoded = decodeLogEvent(logged);
  if (Option.isNone(decoded)) return undefined;
  const event = decoded.value;
  switch (event.type) {
    case "session.tool.input.started":
      names.set(event.data.id, event.data.name);
      return undefined;
    case "session.tool.called":
      return {
        type: "tool_start",
        messageId: event.data.assistantMessageID,
        toolCallId: event.data.id,
        name: names.get(event.data.id) ?? "",
        input: event.data.input,
      };
    case "session.tool.success":
      return {
        type: "tool_end",
        messageId: event.data.assistantMessageID,
        toolCallId: event.data.id,
        name: names.get(event.data.id) ?? "",
        error: false,
        output: (event.data.content ?? []).map((part) => part.text ?? "").join("\n"),
      };
    case "session.tool.failed":
      return {
        type: "tool_end",
        messageId: event.data.assistantMessageID,
        toolCallId: event.data.id,
        name: names.get(event.data.id) ?? "",
        error: true,
        output: event.data.error.message,
      };
    case "session.text.ended":
    case "session.reasoning.ended":
      return {
        type: event.type === "session.text.ended" ? "text_end" : "reasoning_end",
        messageId: event.data.assistantMessageID,
        ordinal: event.data.ordinal,
        text: event.data.text,
      };
    default:
      return undefined;
  }
};
