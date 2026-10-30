import type { SessionUpdate } from "@dorbs/protocol/acp";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { assert, it } from "@effect/vitest";

import { NOTHING_SENT, toSessionUpdates } from "./updates.ts";

const CWD = "/Users/max/project";

// Fixtures are plain JSON shaped like the events Pi emitted in the write-hello run. pi-durable brands
// its entry and conversation ids, which JSON cannot express, hence the one cast.
const play = (fixture: ReadonlyArray<unknown>): ReadonlyArray<SessionUpdate> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- literal JSON cannot carry pi-durable's id brands
  (fixture as ReadonlyArray<AgentEvent>).reduce<[typeof NOTHING_SENT, SessionUpdate[]]>(
    ([sent, out], event) => {
      const [next, updates] = toSessionUpdates(sent, event, CWD);
      return [next, [...out, ...updates]];
    },
    [NOTHING_SENT, []],
  )[1];

const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "faux",
  provider: "faux",
  model: "faux-1",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
});

const toolEnd = (details: unknown, isError: boolean, text: string) => ({
  type: "tool_execution_end",
  toolCallId: "call-1",
  toolName: "edit_file",
  entry: {
    id: 20,
    conversationId: 7,
    kind: "pi.toolResult",
    model: [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "edit_file",
        content: [{ type: "text", text }],
        details,
        isError,
        timestamp: 1,
      },
    ],
  },
});

it("maps an edit to a tool_call, then a tool_call_update with a diff under the client cwd", () => {
  assert.deepStrictEqual(
    play([
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "edit_file",
        args: { path: "src/a.ts", oldText: "1", newText: "2" },
      },
      toolEnd(
        { path: "src/a.ts", oldText: "export const a = 1;\n", newText: "export const a = 2;\n" },
        false,
        "Updated src/a.ts",
      ),
    ]),
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

it("reports a tool error as failed, with its text and no diff", () => {
  assert.deepStrictEqual(
    play([toolEnd(undefined, true, "oldText must occur exactly once in src/a.ts")]),
    [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "failed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "oldText must occur exactly once in src/a.ts" },
          },
        ],
      },
    ],
  );
});

it("streams assistant text once, whether it arrives as a start, a delta, or the final message", () => {
  assert.deepStrictEqual(
    play([
      { type: "message_start", message: assistant("") },
      {
        type: "message_update",
        usage: assistant("").usage,
        changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "Hel" } }],
      },
      {
        type: "message_update",
        usage: assistant("").usage,
        changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }],
      },
      {
        type: "message_end",
        entry: { id: 9, conversationId: 7, kind: "pi.assistant", model: [assistant("Hello!")] },
      },
      { type: "message_start", message: assistant("") },
      {
        type: "message_end",
        entry: { id: 10, conversationId: 7, kind: "pi.assistant", model: [assistant("Done.")] },
      },
    ]),
    [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "!" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
    ],
  );
});

it("sends the text of the partial a streamed message starts with, then only what follows", () => {
  assert.deepStrictEqual(
    play([
      { type: "message_start", message: assistant("I'll start by cl") },
      {
        type: "message_update",
        usage: assistant("").usage,
        changes: [{ type: "text_delta", contentIndex: 0, delta: "oning the repo." }],
      },
      {
        type: "message_end",
        entry: {
          id: 9,
          conversationId: 7,
          kind: "pi.assistant",
          model: [assistant("I'll start by cloning the repo.")],
        },
      },
    ]),
    [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I'll start by cl" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "oning the repo." } },
    ],
  );
});
