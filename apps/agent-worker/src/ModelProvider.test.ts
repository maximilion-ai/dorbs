import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ModelProvider from "./ModelProvider.ts";

/** No model picked: the default. */
const CHOSEN = undefined;

const resolve = (env: Record<string, string>) =>
  Effect.service(ModelProvider.ModelProvider).pipe(
    Effect.provide(
      ModelProvider.layer({}).pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      ),
    ),
  );

it.effect("refuses the scripted model outside alchemy dev", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(resolve({ MODEL_PROVIDER: "scripted", MODEL_ID: "scripted" }));
    assert.strictEqual(
      error.message,
      "Model provider scripted is unavailable: only under alchemy dev (ALCHEMY_DEV=true)",
    );
  }),
);

it.effect("serves the scripted model under alchemy dev", () =>
  Effect.gen(function* () {
    const model = ModelProvider.modelOf(
      yield* resolve({
        MODEL_PROVIDER: "scripted",
        MODEL_ID: "scripted",
        ALCHEMY_DEV: "true",
      }),
      CHOSEN,
    );
    assert.strictEqual(model?.provider, "faux");
  }),
);

it.effect("serves the replay model on a deployed Worker", () =>
  Effect.gen(function* () {
    const model = ModelProvider.modelOf(
      yield* resolve({ MODEL_PROVIDER: "replay", MODEL_ID: "replay" }),
      CHOSEN,
    );
    assert.strictEqual(model?.provider, "faux");
  }),
);

it.effect("refuses OpenCode Go without its key", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      resolve({ MODEL_PROVIDER: "opencode-go", MODEL_ID: "glm-5.3", OPENCODE_API_KEY: "" }),
    );
    assert.strictEqual(
      error.message,
      "Model provider opencode-go is unavailable: OPENCODE_API_KEY is empty",
    );
  }),
);

it.effect("serves OpenCode Go to Pi with its key", () =>
  Effect.gen(function* () {
    const service = yield* resolve({
      MODEL_PROVIDER: "opencode-go",
      MODEL_ID: "glm-5.3",
      OPENCODE_API_KEY: "go-key",
    });
    assert.deepStrictEqual(ModelProvider.modelOf(service, CHOSEN), {
      provider: "opencode-go",
      id: "glm-5.3",
    });
    assert.deepStrictEqual(service.env, { OPENCODE_API_KEY: "go-key" });
  }),
);

it.effect("offers MODELS after the default, with every provider and key they need", () =>
  Effect.gen(function* () {
    const service = yield* resolve({
      MODEL_PROVIDER: "openrouter",
      MODEL_ID: "deepseek/deepseek-v4.1-flash",
      OPENROUTER_API_KEY: "router-key",
      OPENCODE_API_KEY: "go-key",
      MODELS: JSON.stringify([
        { provider: "opencode-go", id: "glm-5.3" },
        { provider: "opencode-go", id: "kimi-k3" },
        { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" },
      ]),
    });
    assert.deepStrictEqual(
      [...service.models.keys()],
      ["openrouter:deepseek/deepseek-v4.1-flash", "opencode-go:glm-5.3", "opencode-go:kimi-k3"],
    );
    assert.deepStrictEqual(
      service.providers.map((provider) => provider.id),
      ["openrouter", "opencode-go"],
    );
    assert.deepStrictEqual(service.env, {
      OPENROUTER_API_KEY: "router-key",
      OPENCODE_API_KEY: "go-key",
    });
    assert.deepStrictEqual(ModelProvider.modelOf(service, "opencode-go:kimi-k3"), {
      provider: "opencode-go",
      id: "kimi-k3",
    });
    assert.deepStrictEqual(ModelProvider.modelOf(service, "gone:model"), {
      provider: "openrouter",
      id: "deepseek/deepseek-v4.1-flash",
    });
  }),
);
