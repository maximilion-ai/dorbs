import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type FauxResponseFactory,
  type Message,
  type ToolCall,
} from "@earendil-works/pi-ai";
export const HELLO = "export const hello = (name: string): string => `Hello, ${name}!`;\n";
export const COUNT = 'export const count: number = "three";\n';
const E2E_HELLO = 'export const n: number = "x";\n';
const E2E_TSCONFIG =
  '{ "compilerOptions": { "strict": true, "noEmit": true }, "include": ["src"] }\n';
const E2E_PACKAGE = '{ "name": "dorbs-e2e", "private": true }\n';

type Step = (signal: AbortSignal | undefined) => AssistantMessage | Promise<AssistantMessage>;

const callTool =
  (name: string, args: ToolCall["arguments"], id: string): Step =>
  () =>
    fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

const say =
  (text: string): Step =>
  () =>
    fauxAssistantMessage([fauxText(text)]);

const untilAborted: Step = (signal) =>
  new Promise((resolve) =>
    signal?.addEventListener("abort", () =>
      resolve(fauxAssistantMessage([], { stopReason: "aborted" })),
    ),
  );

/** Each prompt the tests send picks a script; each model request plays the next step of it. */
const SCRIPTS: Record<string, ReadonlyArray<Step>> = {
  "write hello": [
    callTool("write_file", { path: "src/hello.ts", content: HELLO }, "call-write"),
    say("Wrote src/hello.ts."),
  ],
  typecheck: [
    callTool("write_file", { path: "src/count.ts", content: COUNT }, "call-write"),
    callTool("typecheck", {}, "call-typecheck"),
    say("count is a string."),
  ],
  "wait for cancel": [callTool("list_files", {}, "call-list"), untilAborted],
  e2e: [
    callTool("write_file", { path: "tsconfig.json", content: E2E_TSCONFIG }, "call-tsconfig"),
    callTool("write_file", { path: "package.json", content: E2E_PACKAGE }, "call-package"),
    callTool("write_file", { path: "src/hello.ts", content: E2E_HELLO }, "call-hello"),
    callTool("typecheck", {}, "call-typecheck"),
    say("n is a string."),
  ],
};

const userText = (message: Message | undefined): string => {
  if (message?.role !== "user") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
};

const nextStep = (messages: ReadonlyArray<Message>): Step => {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const script = SCRIPTS[userText(messages[lastUser])] ?? [say("No script for this prompt.")];
  const replies = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
  return script[replies] ?? say("Script finished.");
};

/** A fake model that answers from SCRIPTS, keyed by the prompt text. */
export const scriptedModel = () => {
  const faux = fauxProvider();
  // The faux queue drops each response it plays, so the one factory re-queues itself.
  const respond: FauxResponseFactory = (context, options) => {
    faux.appendResponses([respond]);
    return nextStep(context.messages)(options?.signal);
  };
  faux.setResponses([respond]);
  return { provider: faux.provider, model: faux.getModel() };
};
