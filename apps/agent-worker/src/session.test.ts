import type { SessionConfigOption, SessionUpdate } from "@dorbs/protocol/acp";
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
  run: SessionHost["run"] = async (_record, _prompt, _operation, _signal, emit) => {
    for (const update of emitted) emit(update);
    return RunOutcome.Answered();
  },
  savePrompts: (prompts: ReadonlyArray<OpenPrompt>) => void = () => {},
) => {
  const sent: string[] = [];
  /** The records the session moved its loop to a picked model for. */
  const moved: SessionRecord[] = [];
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
      savePrompts(next);
      prompts = next;
    },
    replay: () => {},
    send: (_connection, message) => {
      sent.push(message);
    },
    choices: [
      { value: "openrouter:deepseek", name: "deepseek · OpenRouter" },
      { value: "chatgpt:gpt-6-sol", name: "gpt-6-sol · ChatGPT" },
    ],
    setModel: async (next) => {
      moved.push(next);
    },
    run,
  };
  const session = makeSession(host);
  const offered = session.open(CLIENT, "/project");
  /** Prompts once, then gives the prompt's response and every session/update sent. */
  const prompt = Effect.fn("Test.prompt")(function* (id = 2) {
    yield* session.receive(CLIENT, {
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { sessionId: "session-1", prompt: [{ type: "text", text: "edit" }] },
    });
    const frames = yield* Effect.promise(() =>
      vi.waitFor(() => {
        const parsed = sent.map((message) => JSON.parse(message));
        assert.isTrue(parsed.some((frame) => frame.id === id));
        return parsed;
      }),
    );
    return {
      response: frames.find((frame) => frame.id === id),
      updates: frames.flatMap((frame) => (frame.id === undefined ? [frame.params.update] : [])),
    };
  });
  /** Sends one request and gives its response. */
  const request = Effect.fn("Test.request")(function* (
    id: number,
    method: string,
    params: unknown,
  ) {
    yield* session.receive(CLIENT, { jsonrpc: "2.0", id, method, params });
    return sent.map((message) => JSON.parse(message)).find((frame) => frame.id === id);
  });
  return { prompt, request, offered, moved, record: () => record };
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
      const { response, updates } = yield* prompt();
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
      const { response, updates } = yield* prompt();
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
      const { response } = yield* prompt();
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

it.effect("answers a prompt whose turn breaks outside the loop, and runs the next one", () =>
  Effect.gen(function* () {
    let broken = true;
    const { prompt } = sessionWith(
      [],
      () => {},
      undefined,
      (prompts) => {
        if (broken && prompts[0]?.started === true) {
          broken = false;
          throw new Error("SQLITE_FULL");
        }
      },
    );
    const first = yield* prompt(2);
    assert.deepStrictEqual(first.response.error, { code: -32603, message: "SQLITE_FULL" });
    const second = yield* prompt(3);
    assert.deepStrictEqual(second.response.result, { stopReason: "end_turn" });
  }),
);

const modelOption = (currentValue: string): ReadonlyArray<SessionConfigOption> => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [
      { value: "openrouter:deepseek", name: "deepseek · OpenRouter" },
      { value: "chatgpt:gpt-6-sol", name: "gpt-6-sol · ChatGPT" },
    ],
  },
];

it.effect("runs on the model picked in T3 and reports it on load", () =>
  Effect.gen(function* () {
    const { request, offered, moved, record } = sessionWith([], () => {});
    assert.deepStrictEqual(offered, modelOption("openrouter:deepseek"));

    const picked = yield* request(2, "session/set_config_option", {
      sessionId: "session-1",
      configId: "model",
      value: "chatgpt:gpt-6-sol",
    });
    assert.deepStrictEqual(picked.result, { configOptions: modelOption("chatgpt:gpt-6-sol") });
    assert.strictEqual(record()?.model, "chatgpt:gpt-6-sol");
    assert.deepStrictEqual(
      moved.map((next) => next.model),
      ["chatgpt:gpt-6-sol"],
    );

    const loaded = yield* request(3, "session/load", {
      sessionId: "session-1",
      cwd: "/project",
      mcpServers: [],
    });
    assert.deepStrictEqual(loaded.result, { configOptions: modelOption("chatgpt:gpt-6-sol") });
  }),
);

it.effect("refuses a model the deployment does not offer and keeps the one it runs on", () =>
  Effect.gen(function* () {
    const { request, moved, record } = sessionWith([], () => {});
    const refused = yield* request(2, "session/set_config_option", {
      sessionId: "session-1",
      configId: "model",
      value: "openrouter:gone",
    });
    assert.strictEqual(refused.error.code, -32602);
    assert.strictEqual(record()?.model, undefined);
    assert.deepStrictEqual(moved, []);
  }),
);
