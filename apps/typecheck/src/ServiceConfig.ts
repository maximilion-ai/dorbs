import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class ServiceConfig extends Context.Service<
  ServiceConfig,
  {
    readonly dataDir: string;
    readonly token: Redacted.Redacted;
  }
>()("dorbs/typecheck/ServiceConfig") {}

const make = Effect.gen(function* () {
  return yield* Config.all({
    dataDir: Config.NonEmptyString("DATA_DIR"),
    token: Config.schema(Schema.Redacted(Schema.NonEmptyString), "TYPECHECK_TOKEN"),
  });
});

export const layer = Layer.effect(ServiceConfig, make);
