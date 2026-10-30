import type { SessionUpdate, ToolCallContent } from "@dorbs/protocol/acp";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";

import { FileChange, toolPresentation } from "./tools.ts";

/** Characters already sent of each text or thinking block in the in-flight assistant message, by index. */
export type Sent = ReadonlyMap<number, number>;
export const NOTHING_SENT: Sent = new Map();

type Block = AssistantMessage["content"][number];
type Mapped = readonly [Sent, ReadonlyArray<SessionUpdate>];

const isFileChange = Schema.is(FileChange);

const underCwd = (cwd: string, path: string): string => `${cwd.replace(/\/+$/, "")}/${path}`;

/** A tool call starting, as T3 shows it: its title and kind, and the file it names. */
export const toolCall = (
  toolCallId: string,
  name: string,
  args: { readonly [key: string]: Schema.Json },
  cwd: string,
): SessionUpdate => {
  const path = typeof args["path"] === "string" ? args["path"] : undefined;
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    ...toolPresentation(name, args),
    status: "in_progress",
    rawInput: args,
    ...(path === undefined ? {} : { locations: [{ path: underCwd(cwd, path) }] }),
  };
};

/** A tool call's result: its text, and a write's diff from the result's `details`. */
export const toolCallEnd = (
  toolCallId: string,
  failed: boolean,
  texts: ReadonlyArray<string>,
  details: unknown,
  cwd: string,
): SessionUpdate => {
  const content: ToolCallContent[] = texts.map((text) => ({
    type: "content",
    content: { type: "text", text },
  }));
  if (isFileChange(details)) {
    const { path, oldText, newText } = details;
    content.push({
      type: "diff",
      path: underCwd(cwd, path),
      ...(oldText === undefined ? {} : { oldText }),
      newText,
    });
  }
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: failed ? "failed" : "completed",
    content,
  };
};

const blockText = (block: Block): string | undefined =>
  block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : undefined;

const chunk = (block: Block, text: string): SessionUpdate => ({
  sessionUpdate: block.type === "thinking" ? "agent_thought_chunk" : "agent_message_chunk",
  content: { type: "text", text },
});

// Pi commits partial answers in batches and may resend a block or the whole message, while ACP chunks
// only append, so each block sends just the characters past what was already sent.
const catchUp = (sent: Map<number, number>, index: number, block: Block): SessionUpdate[] => {
  const text = blockText(block);
  if (text === undefined) return [];
  const from = sent.get(index) ?? 0;
  sent.set(index, Math.max(from, text.length));
  return text.length > from ? [chunk(block, text.slice(from))] : [];
};

const messageUpdate = (
  before: Sent,
  changes: Extract<AgentEvent, { type: "message_update" }>["changes"],
): Mapped => {
  const sent = new Map(before);
  const updates = changes.flatMap((change): SessionUpdate[] => {
    switch (change.type) {
      case "text_start":
      case "thinking_start":
      case "block":
        return catchUp(sent, change.contentIndex, change.block);
      case "text_delta":
      case "thinking_delta": {
        sent.set(change.contentIndex, (sent.get(change.contentIndex) ?? 0) + change.delta.length);
        return [
          {
            sessionUpdate:
              change.type === "thinking_delta" ? "agent_thought_chunk" : "agent_message_chunk",
            content: { type: "text", text: change.delta },
          },
        ];
      }
      case "message":
        return change.message.content.flatMap((block, index) => catchUp(sent, index, block));
      default:
        return [];
    }
  });
  return [sent, updates];
};

const toolResult = (event: Extract<AgentEvent, { type: "tool_execution_end" }>) => {
  const message = event.entry?.model?.[0];
  return message?.role === "toolResult" ? message : undefined;
};

/** Maps one Pi agent event to the ACP session updates it produces. Paths are reported under the client cwd. */
export const toSessionUpdates = (sent: Sent, event: AgentEvent, cwd: string): Mapped => {
  switch (event.type) {
    // Pi starts a streamed message with its first committed partial, which may already hold text.
    case "message_start": {
      const { message } = event;
      if (message.role !== "assistant") return [NOTHING_SENT, []];
      const next = new Map<number, number>();
      return [next, message.content.flatMap((block, index) => catchUp(next, index, block))];
    }
    case "message_update":
      return messageUpdate(sent, event.changes);
    case "message_end": {
      const message = event.entry.model?.[0];
      if (message?.role !== "assistant") return [NOTHING_SENT, []];
      const next = new Map(sent);
      return [NOTHING_SENT, message.content.flatMap((block, index) => catchUp(next, index, block))];
    }
    case "tool_execution_start":
      return [sent, [toolCall(event.toolCallId, event.toolName, event.args, cwd)]];
    case "tool_execution_end": {
      const result = toolResult(event);
      if (result === undefined) {
        return [
          sent,
          [{ sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, status: "failed" }],
        ];
      }
      const texts = result.content.flatMap((item) => (item.type === "text" ? [item.text] : []));
      return [sent, [toolCallEnd(event.toolCallId, result.isError, texts, result.details, cwd)]];
    }
    default:
      return [sent, []];
  }
};
