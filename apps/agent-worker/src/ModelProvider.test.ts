import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ModelProvider from "./ModelProvider.ts";

const resolve = (env: Record<string, string>) =>
  Effect.service(ModelProvider.ModelProvider).pipe(
    Effect.provide(
      ModelProvider.layer(undefined).pipe(
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
    const { model } = yield* resolve({
      MODEL_PROVIDER: "scripted",
      MODEL_ID: "scripted",
      ALCHEMY_DEV: "true",
    });
    assert.strictEqual(model.provider, "faux");
  }),
);
