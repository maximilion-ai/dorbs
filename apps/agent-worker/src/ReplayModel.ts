import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
  type Message,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";

/** A prompt that starts with this carries a plan: the rest is JSON, one array of parallel tool calls per round. */
const REPLAY_PREFIX = "replay ";

type Call = { readonly name: string; readonly args: ToolCall["arguments"] };
type Plan = ReadonlyArray<ReadonlyArray<Call>>;

const textOf = (message: Message): string =>
  message.role !== "user"
    ? ""
    : typeof message.content === "string"
      ? message.content
      : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/**
 * A model that plays back the tool calls a plan in the prompt names, round by round, whatever the tools return, and
 * calls no network model. It measures the infrastructure alone: the plan is fixed, so only tool results and their
 * timing differ between runs. A prompt without a plan gets a one-line answer.
 */
export const replayModel = () => {
  const faux = fauxProvider();
  const respond: FauxResponseFactory = (context) => {
    faux.appendResponses([respond]);
    const lastUser = context.messages.findLastIndex((m) => m.role === "user");
    const prompt = lastUser === -1 ? "" : textOf(context.messages[lastUser]!);
    if (!prompt.startsWith(REPLAY_PREFIX)) return fauxAssistantMessage([fauxText("No plan.")]);
    const plan: Plan = JSON.parse(prompt.slice(REPLAY_PREFIX.length));
    const round = context.messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
    const calls = plan[round];
    if (calls === undefined) return fauxAssistantMessage([fauxText("Replayed.")]);
    return fauxAssistantMessage(
      calls.map((call) =>
        fauxToolCall(call.name, call.args, { id: `replay-${crypto.randomUUID()}` }),
      ),
      { stopReason: "toolUse" },
    );
  };
  faux.setResponses([respond]);
  const provider: Provider = faux.provider;
  return { provider, model: faux.getModel() };
};
