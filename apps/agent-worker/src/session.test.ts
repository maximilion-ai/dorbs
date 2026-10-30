import type { SessionUpdate } from "@dorbs/protocol/acp";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ConnectionId } from "./rpc.ts";
import {
  makeSession,
  type OpenPrompt,
  type SessionHost,
  type SessionRecord,
  type StreamedRun,
} from "./session.ts";
import { RunOutcome } from "./Turn.ts";

const CLIENT = ConnectionId.make("client");
const ROW_BYTES = 256 * 1024;

/** A session over an in-memory host whose one run emits `emitted`; `remember` stands in for the history table. */
const sessionWith = (
  emitted: ReadonlyArray<SessionUpdate>,
  remember: (message: string) => void,
  run: SessionHost["run"] = async (_record, _prompt, _operationId, _signal, emit) => {
    for (const update of emitted) emit(update);
    return RunOutcome.Answered();
  },
) => {
  const sent: string[] = [];
  let record: SessionRecord | undefined;
  let attached: ConnectionId | undefined;
  let prompts: ReadonlyArray<OpenPrompt> = [];
  let held: StreamedRun | undefined;
  const host: SessionHost = {
    sessionId: "session-1",
    record: () => record,
    saveRecord: (next) => {
      record = next;
    },
    attached: () => attached,
    attach: (connection) => {
      attached = connection;
    },
    remember,
    hold: (sessionUpdate, text) => {
      held = { sessionUpdate, text: `${held?.text ?? ""}${text}` };
    },
    release: () => {
      const run = held;
      held = undefined;
      return run;
    },
    prompts: () => prompts,
    savePrompts: (next) => {
      prompts = next;
    },
    replay: () => {},
    send: (_connection, message) => {
      sent.push(message);
    },
    run,
  };
  const session = makeSession(host);
  session.open(CLIENT, "/project");
  /** Prompts once, then gives the prompt's response and every session/update sent. */
  const prompt = Effect.gen(function* () {
    yield* session.receive(CLIENT, {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "session-1", prompt: [{ type: "text", text: "edit" }] },
    });
    const frames = yield* Effect.promise(() =>
      vi.waitFor(() => {
        const parsed = sent.map((message) => JSON.parse(message));
        assert.isTrue(parsed.some((frame) => frame.id === 2));
        return parsed;
      }),
    );
    return {
      response: frames.find((frame) => frame.id === 2),
      updates: frames.flatMap((frame) => (frame.id === undefined ? [frame.params.update] : [])),
    };
  });
  return { prompt };
};

const BIG = "x".repeat(3 * 1024 * 1024);

const bigEdit: SessionUpdate = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call-edit",
  status: "completed",
  content: [
    { type: "content", content: { type: "text", text: "Updated big.txt" } },
    { type: "diff", path: "/project/big.txt", oldText: BIG, newText: `${BIG}y` },
  ],
};

it.effect(
  "keeps a tool result too big for a history row cut to 256 KiB, marked, and sends it whole",
  () =>
    Effect.gen(function* () {
      const kept: string[] = [];
      const { prompt } = sessionWith([bigEdit], (message) => kept.push(message));
      const { response, updates } = yield* prompt;
      assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
      assert.deepStrictEqual(updates, [bigEdit]);
      const row = kept.find((message) => message.includes("call-edit")) ?? "";
      assert.isAtMost(new TextEncoder().encode(row).byteLength, ROW_BYTES);
      const { content } = JSON.parse(row).params.update;
      assert.deepStrictEqual(content[0], bigEdit.content?.[0]);
      assert.match(
        content[1].newText,
        /^x+\n\[… \d+ more characters not kept in the session history\]$/u,
      );
    }),
);

it.effect(
  "fails a tool update visibly when the history cannot keep it, and still ends the turn",
  () =>
    Effect.gen(function* () {
      const kept: string[] = [];
      const { prompt } = sessionWith([bigEdit], (message) => {
        if (message.includes('"completed"')) throw new Error("SQLITE_TOOBIG");
        kept.push(message);
      });
      const { response, updates } = yield* prompt;
      assert.deepStrictEqual(response.result, { stopReason: "end_turn" });
      const failed: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-edit",
        status: "failed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "The session history could not keep this result: SQLITE_TOOBIG",
            },
          },
        ],
      };
      assert.deepStrictEqual(updates, [failed]);
      assert.deepStrictEqual(
        kept.map((message) => JSON.parse(message).params.update),
        [
          { sessionUpdate: "user_message_chunk", content: { type: "text", text: "edit" } },
          failed,
          {
            sessionUpdate: "session_info_update",
            _meta: { "dorbs/turnEnded": { stopReason: "end_turn" } },
          },
        ],
      );
    }),
);

it.effect(
  "answers the prompt with the error when its agent loop throws, and keeps how it ended",
  () =>
    Effect.gen(function* () {
      const kept: string[] = [];
      const { prompt } = sessionWith(
        [],
        (message) => kept.push(message),
        async () => {
          throw new Error("OpenCode: the event stream did not open");
        },
      );
      const { response } = yield* prompt;
      assert.deepStrictEqual(response.error, {
        code: -32603,
        message: "OpenCode: the event stream did not open",
      });
      assert.deepStrictEqual(JSON.parse(kept.at(-1) ?? "").params.update, {
        sessionUpdate: "session_info_update",
        _meta: { "dorbs/turnEnded": { error: "OpenCode: the event stream did not open" } },
      });
    }),
);
