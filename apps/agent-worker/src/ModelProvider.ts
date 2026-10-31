import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { Provider } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { Model, Provider as OpenCodeProvider, type Plugin } from "@opencode/plugin";
import type { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import type { PiModel } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { scriptedLanguageModel, scriptedModel } from "./ScriptedModel.ts";

export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()("ModelUnavailable", {
  provider: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `Model provider ${this.provider} is unavailable: ${this.reason}`;
  }
}

/** The same model as OpenCode reaches it: the plugins that add its provider, provider config, and the model. */
export type OpenCodeModel = {
  readonly model: { readonly providerID: string; readonly id: string };
  readonly plugins: ReadonlyArray<Plugin.Plugin>;
  readonly providers?: NonNullable<OpenCodeWorkerd.Configuration["providers"]>;
};

/**
 * The pi-ai provider Pi generates with and the model new sessions start on, the secrets the provider reads by name,
 * and the same model for OpenCode where this Worker wires one.
 */
export class ModelProvider extends Context.Service<
  ModelProvider,
  {
    readonly provider: Provider;
    readonly model: PiModel;
    /** Pi's provider reads these as environment variables; celld leaves a Worker's vars out of process.env. */
    readonly env?: Readonly<Record<string, string>>;
    readonly openCode?: OpenCodeModel;
  }
>()("dorbs/agent-worker/ModelProvider") {}

const ModelConfig = Config.all({
  provider: Config.Literals(["openrouter", "workers-ai", "scripted"], "MODEL_PROVIDER"),
  id: Config.NonEmptyString("MODEL_ID"),
  dev: Config.Boolean("ALCHEMY_DEV").pipe(Config.withDefault(false)),
});

/**
 * An OpenCode plugin that adds provider `id` with one model, which `language` answers for. OpenCode builds an AI SDK
 * model from a package, so the provider names one OpenCode cannot load and the plugin hands over the SDK instead.
 */
const languageModel = (id: string, language: LanguageModelV3): OpenCodeModel => {
  const providerID = OpenCodeProvider.ID.make(id);
  const pkg = `aisdk:dorbs-${id}`;
  return {
    model: { providerID: id, id },
    plugins: [
      {
        id: `dorbs.models.${id}`,
        setup: async (ctx) => {
          const transform = await ctx.provider.transform((editor) => {
            editor.add({
              info: { id: providerID, name: id, activation: "enabled", package: pkg },
              models: [{ ...Model.Info.default(providerID, Model.ID.make(id)), package: pkg }],
            });
          });
          const hook = await ctx.aisdk.hook(
            "sdk",
            (event) => {
              event.sdk = { languageModel: () => language };
            },
            { providerID },
          );
          return async () => {
            await hook.dispose();
            await transform.dispose();
          };
        },
      },
    ],
  };
};

/**
 * Reads MODEL_PROVIDER and MODEL_ID. OpenRouter needs the OPENROUTER_API_KEY secret, which Pi reads as an
 * environment variable and OpenCode takes in its config; Workers AI needs the Worker's `AI` binding and serves Pi only.
 * The scripted model
 * runs only under `alchemy dev`, which sets ALCHEMY_DEV, so a deployed Worker cannot answer from a script.
 */
export const layer = (ai: Ai | undefined) =>
  Layer.effect(
    ModelProvider,
    Effect.gen(function* () {
      const config = yield* ModelConfig;
      if (config.provider === "openrouter") {
        const apiKey = yield* Config.Redacted("OPENROUTER_API_KEY");
        return {
          provider: openrouterProvider(),
          model: { provider: "openrouter", id: config.id },
          env: { OPENROUTER_API_KEY: Redacted.value(apiKey) },
          openCode: {
            model: { providerID: "openrouter", id: config.id },
            plugins: [],
            providers: { openrouter: { settings: { apiKey: Redacted.value(apiKey) } } },
          },
        };
      }
      if (config.provider === "scripted") {
        if (!config.dev) {
          return yield* new ModelUnavailable({
            provider: config.provider,
            reason: "only under alchemy dev (ALCHEMY_DEV=true)",
          });
        }
        return { ...scriptedModel(), openCode: languageModel("scripted", scriptedLanguageModel()) };
      }
      if (ai === undefined) {
        return yield* new ModelUnavailable({ provider: config.provider, reason: "no AI binding" });
      }
      const workersAi = createAI({ binding: ai });
      return { provider: workersAi.provider, model: workersAi(config.id) };
    }),
  );
