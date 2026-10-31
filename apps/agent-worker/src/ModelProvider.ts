import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
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

import { replayModel } from "./ReplayModel.ts";
import { accountCredentials, type ChatGptAccount } from "./ChatGptAccount.ts";
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
 * What Pi generates with: a pi-ai provider for each provider the choices name, each choice's model by its value with
 * the default first, the secrets the providers read by name, and the default model for OpenCode where one is wired.
 */
export class ModelProvider extends Context.Service<
  ModelProvider,
  {
    readonly providers: ReadonlyArray<Provider>;
    readonly models: ReadonlyMap<string, PiModel>;
    /** Pi's providers read these as environment variables; celld leaves a Worker's vars out of process.env. */
    readonly env?: Readonly<Record<string, string>>;
    /** Where Pi reads OAuth credentials; for providers that sign in rather than take a key. */
    readonly credentials?: CredentialStore;
    readonly openCode?: OpenCodeModel;
  }
>()("dorbs/agent-worker/ModelProvider") {}

const PROVIDERS = [
  "openrouter",
  "opencode-go",
  "chatgpt",
  "workers-ai",
  "scripted",
  "replay",
] as const;
type ProviderName = (typeof PROVIDERS)[number];
const LABELS: Record<ProviderName, string> = {
  openrouter: "OpenRouter",
  "opencode-go": "OpenCode Go",
  chatgpt: "ChatGPT",
  "workers-ai": "Workers AI",
  scripted: "scripted",
  replay: "replay",
};

/** A model a session may run on: `value` is what T3's picker sends back, `name` what it shows. */
export type ModelChoice = {
  readonly value: string;
  readonly name: string;
  readonly provider: ProviderName;
  readonly id: string;
};

const choice = (provider: ProviderName, id: string): ModelChoice => ({
  value: `${provider}:${id}`,
  name: `${id} · ${LABELS[provider]}`,
  provider,
  id,
});

const Listed = Schema.Struct({ provider: Schema.Literals(PROVIDERS), id: Schema.NonEmptyString });

/**
 * The models sessions pick from: MODEL_PROVIDER and MODEL_ID, the default, then MODELS, a JSON array of
 * `{ "provider": "chatgpt", "id": "gpt-6-sol" }`.
 */
export const ModelChoices = Config.all({
  provider: Config.Literals(PROVIDERS, "MODEL_PROVIDER"),
  id: Config.NonEmptyString("MODEL_ID"),
  listed: Config.schema(Schema.fromJsonString(Schema.Array(Listed)), "MODELS").pipe(
    Config.withDefault([]),
  ),
}).pipe(
  Config.map(({ provider, id, listed }) => {
    const choices = [choice(provider, id), ...listed.map((m) => choice(m.provider, m.id))];
    return choices.filter((c, i) => choices.findIndex((other) => other.value === c.value) === i);
  }),
);

/** The model a session runs on: the one it picked, or the default when it picked none or one no longer offered. */
export const modelOf = (
  service: ModelProvider["Service"],
  picked: string | undefined,
): PiModel | undefined =>
  (picked === undefined ? undefined : service.models.get(picked)) ??
  service.models.values().next().value;

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

/** One choice's model and what Pi needs to reach it. */
type Resolved = {
  readonly provider: Provider;
  readonly model: PiModel;
  readonly env?: Readonly<Record<string, string>>;
  readonly credentials?: CredentialStore;
  readonly openCode?: OpenCodeModel;
};

type Bindings = {
  readonly AI?: Ai;
  readonly ChatGptAccount?: DurableObjectNamespace<ChatGptAccount>;
};

/**
 * One choice's model. OpenRouter needs OPENROUTER_API_KEY and serves Pi and OpenCode; OpenCode Go (OPENCODE_API_KEY),
 * ChatGPT (a signed-in ChatGptAccount) and Workers AI (the `AI` binding) serve Pi only. The scripted model runs only
 * under `alchemy dev` (ALCHEMY_DEV); the replay model plays back a prompt's tool calls.
 */
const resolve = Effect.fn("ModelProvider.resolve")(function* (
  env: Bindings,
  { provider, id }: ModelChoice,
) {
  if (provider === "openrouter") {
    const apiKey = yield* Config.Redacted("OPENROUTER_API_KEY");
    return {
      provider: openrouterProvider(),
      model: { provider: "openrouter", id },
      env: { OPENROUTER_API_KEY: Redacted.value(apiKey) },
      openCode: {
        model: { providerID: "openrouter", id },
        plugins: [],
        providers: { openrouter: { settings: { apiKey: Redacted.value(apiKey) } } },
      } satisfies OpenCodeModel,
    };
  }
  if (provider === "replay") return replayModel();
  if (provider === "opencode-go") {
    // An empty binding reads as missing, so both mean no key.
    const apiKey = Redacted.value(
      yield* Config.Redacted("OPENCODE_API_KEY").pipe(Config.withDefault(Redacted.make(""))),
    );
    if (apiKey === "") {
      return yield* new ModelUnavailable({ provider, reason: "OPENCODE_API_KEY is empty" });
    }
    return {
      provider: opencodeGoProvider(),
      model: { provider: "opencode-go", id },
      env: { OPENCODE_API_KEY: apiKey },
    };
  }
  if (provider === "chatgpt") {
    if (env.ChatGptAccount === undefined) {
      return yield* new ModelUnavailable({ provider, reason: "no ChatGptAccount binding" });
    }
    return {
      provider: openaiProvider(),
      model: { provider: "openai", id },
      credentials: accountCredentials(env.ChatGptAccount.getByName("default"), "openai"),
    };
  }
  if (provider === "scripted") {
    if (!(yield* Config.Boolean("ALCHEMY_DEV").pipe(Config.withDefault(false)))) {
      return yield* new ModelUnavailable({
        provider,
        reason: "only under alchemy dev (ALCHEMY_DEV=true)",
      });
    }
    return { ...scriptedModel(), openCode: languageModel("scripted", scriptedLanguageModel()) };
  }
  if (env.AI === undefined) {
    return yield* new ModelUnavailable({ provider, reason: "no AI binding" });
  }
  const workersAi = createAI({ binding: env.AI });
  return { provider: workersAi.provider, model: workersAi(id) };
});

/** Every choice's model, with the providers, secrets and credentials they need; any that is unavailable fails it. */
export const layer = (env: Bindings) =>
  Layer.effect(
    ModelProvider,
    Effect.gen(function* () {
      const choices = yield* ModelChoices;
      const picks = yield* Effect.forEach(choices, (c) =>
        resolve(env, c).pipe(Effect.map((r): readonly [string, Resolved] => [c.value, r])),
      );
      const resolved = picks.map(([, r]) => r);
      const credentials = resolved.find((r) => r.credentials !== undefined)?.credentials;
      const openCode = resolved[0]?.openCode;
      return {
        providers: [...new Map(resolved.map((r) => [r.provider.id, r.provider])).values()],
        models: new Map(picks.map(([value, r]) => [value, r.model])),
        env: Object.assign({}, ...resolved.map((r) => r.env)),
        ...(credentials === undefined ? {} : { credentials }),
        ...(openCode === undefined ? {} : { openCode }),
      };
    }),
  );
