import type { Provider } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { PiModel } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { scriptedModel } from "./ScriptedModel.ts";

export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()("ModelUnavailable", {
  provider: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `Model provider ${this.provider} is unavailable: ${this.reason}`;
  }
}

/** The pi-ai provider Pi generates with, and the model new sessions start on. */
export class ModelProvider extends Context.Service<
  ModelProvider,
  { readonly provider: Provider; readonly model: PiModel }
>()("dorbs/agent-worker/ModelProvider") {}

const ModelConfig = Config.all({
  provider: Config.Literals(["openrouter", "workers-ai", "scripted"], "MODEL_PROVIDER"),
  id: Config.NonEmptyString("MODEL_ID"),
  dev: Config.Boolean("ALCHEMY_DEV").pipe(Config.withDefault(false)),
});

/**
 * Reads MODEL_PROVIDER and MODEL_ID. OpenRouter reads its OPENROUTER_API_KEY secret from the environment
 * itself; Workers AI needs the Worker's `AI` binding. The scripted model runs only under `alchemy dev`,
 * which sets ALCHEMY_DEV, so a deployed Worker cannot answer from a script.
 */
export const layer = (ai: Ai | undefined) =>
  Layer.effect(
    ModelProvider,
    Effect.gen(function* () {
      const config = yield* ModelConfig;
      if (config.provider === "openrouter") {
        return { provider: openrouterProvider(), model: { provider: "openrouter", id: config.id } };
      }
      if (config.provider === "scripted") {
        if (!config.dev) {
          return yield* new ModelUnavailable({
            provider: config.provider,
            reason: "only under alchemy dev (ALCHEMY_DEV=true)",
          });
        }
        return scriptedModel();
      }
      if (ai === undefined) {
        return yield* new ModelUnavailable({ provider: config.provider, reason: "no AI binding" });
      }
      const workersAi = createAI({ binding: ai });
      return { provider: workersAi.provider, model: workersAi(config.id) };
    }),
  );
