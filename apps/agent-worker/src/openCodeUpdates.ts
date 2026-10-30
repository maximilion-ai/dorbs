import type { SessionUpdate } from "@dorbs/protocol/acp";
import type { OpenCodeSessionEvent } from "agents/harness/opencode";
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
