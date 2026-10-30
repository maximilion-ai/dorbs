import type { SessionUpdate } from "@dorbs/protocol/acp";
import { assert, it } from "@effect/vitest";
import type { OpenCodeSessionEvent } from "agents/harness/opencode";

import { NOTHING_STREAMED, toOpenCodeUpdates } from "./openCodeUpdates.ts";

const CWD = "/Users/max/project";

const play = (
  events: ReadonlyArray<OpenCodeSessionEvent>,
  details: Record<string, unknown> = {},
): ReadonlyArray<SessionUpdate> =>
  events.reduce<[typeof NOTHING_STREAMED, SessionUpdate[]]>(
    ([streamed, out], event) => {
      const [next, updates] = toOpenCodeUpdates(streamed, event, CWD, (id) => details[id]);
      return [next, [...out, ...updates]];
    },
    [NOTHING_STREAMED, []],
  )[1];

const said = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

it("maps an edit to a tool_call, then a tool_call_update with the diff its details carry", () => {
  assert.deepStrictEqual(
    play(
      [
        {
          type: "tool_start",
          messageId: "msg_1",
          toolCallId: "call-1",
          name: "edit_file",
          input: { path: "src/a.ts", oldText: "1", newText: "2" },
        },
        {
          type: "tool_end",
          messageId: "msg_1",
          toolCallId: "call-1",
          name: "edit_file",
          error: false,
          output: "Updated src/a.ts",
        },
      ],
      {
        "call-1": {
          path: "src/a.ts",
          oldText: "export const a = 1;\n",
          newText: "export const a = 2;\n",
        },
      },
    ),
    [
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "edit_file src/a.ts",
        kind: "edit",
        status: "in_progress",
        rawInput: { path: "src/a.ts", oldText: "1", newText: "2" },
        locations: [{ path: "/Users/max/project/src/a.ts" }],
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "Updated src/a.ts" } },
          {
            type: "diff",
            path: "/Users/max/project/src/a.ts",
            oldText: "export const a = 1;\n",
            newText: "export const a = 2;\n",
          },
        ],
      },
    ],
  );
});

it("reports a failed call with its error text and no diff", () => {
  assert.deepStrictEqual(
    play([
      {
        type: "tool_end",
        messageId: "msg_1",
        toolCallId: "call-1",
        name: "git",
        error: true,
        output: "Force pushes are not allowed.",
      },
    ]),
    [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "failed",
        content: [
          { type: "content", content: { type: "text", text: "Force pushes are not allowed." } },
        ],
      },
    ],
  );
});

it("sends each delta once, and from a part's end only what the deltas missed", () => {
  assert.deepStrictEqual(
    play([
      { type: "reasoning_delta", messageId: "msg_1", ordinal: 0, delta: "Think" },
      { type: "reasoning_end", messageId: "msg_1", ordinal: 0, text: "Think" },
      { type: "text_delta", messageId: "msg_1", ordinal: 0, delta: "Hel" },
      { type: "text_end", messageId: "msg_1", ordinal: 0, text: "Hello." },
      { type: "text_end", messageId: "msg_1", ordinal: 1, text: "Second part." },
      { type: "message_end", messageId: "msg_1", finish: "stop" },
    ]),
    [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Think" } },
      said("Hel"),
      said("lo."),
      said("Second part."),
    ],
  );
});

it("keeps the parts of two messages apart", () => {
  assert.deepStrictEqual(
    play([
      { type: "text_delta", messageId: "msg_1", ordinal: 0, delta: "One." },
      { type: "message_end", messageId: "msg_1", finish: "tool-calls" },
      { type: "text_end", messageId: "msg_2", ordinal: 0, text: "Two." },
    ]),
    [said("One."), said("Two.")],
  );
});
