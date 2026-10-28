import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { RepoId } from "@dorbs/protocol/typecheck";

/** A repo the operator registered: checks fetch its commits from `url`, with `token` if it has one. */
export type Repo = {
  readonly id: RepoId;
  readonly url: string;
  readonly token: Redacted.Redacted | undefined;
};

export class ServiceConfig extends Context.Service<
  ServiceConfig,
  {
    readonly dataDir: string;
    readonly token: Redacted.Redacted;
    readonly repos: ReadonlyMap<RepoId, Repo>;
  }
>()("dorbs/typecheck/ServiceConfig") {}

const Registrations = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: RepoId,
      url: Schema.NonEmptyString,
      /** Names the environment variable that holds the repo's read token. */
      tokenEnv: Schema.optionalKey(Schema.NonEmptyString),
    }),
  ).check(
    Schema.makeFilter((repos) => new Set(repos.map((repo) => repo.id)).size === repos.length, {
      expected: "repos with distinct ids",
    }),
  ),
);
const decodeRegistrations = Schema.decodeEffect(Registrations);

const make = Effect.gen(function* () {
  const config = yield* Config.all({
    dataDir: Config.NonEmptyString("DATA_DIR"),
    token: Config.schema(Schema.Redacted(Schema.NonEmptyString), "TYPECHECK_TOKEN"),
    reposFile: Config.NonEmptyString("REPOS_FILE"),
  });
  const registrations = yield* decodeRegistrations(
    yield* (yield* FileSystem.FileSystem).readFileString(config.reposFile),
  );
  const repos = yield* Effect.forEach(registrations, (registration) =>
    Effect.gen(function* () {
      const token =
        registration.tokenEnv === undefined
          ? undefined
          : yield* Config.Redacted(registration.tokenEnv);
      return { id: registration.id, url: registration.url, token } satisfies Repo;
    }),
  );
  return {
    dataDir: config.dataDir,
    token: config.token,
    repos: new Map(repos.map((repo) => [repo.id, repo])),
  };
});

export const layer = Layer.effect(ServiceConfig, make);
