import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  GitHubAppConfig,
  type GitHubAppFailed,
  gitHubRepo,
  installationTokens,
} from "@dorbs/protocol/github-app";
import { RepoId } from "@dorbs/protocol/typecheck";

/** A repo the operator registered: checks fetch its commits from `url`, with `token` if it has one. */
export type Repo = {
  readonly id: RepoId;
  readonly url: string;
  /** The read token for one fetch: tokenEnv's, one the GitHub App mints for a github.com repo, or none. */
  readonly token: Effect.Effect<Redacted.Redacted | undefined, GitHubAppFailed>;
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
  const app = yield* GitHubAppConfig;
  const mint = Option.isSome(app)
    ? yield* installationTokens(app.value, { contents: "read", metadata: "read" })
    : undefined;
  const repos = yield* Effect.forEach(registrations, (registration) =>
    Effect.gen(function* () {
      const github = gitHubRepo(registration.url);
      const token =
        registration.tokenEnv !== undefined
          ? Effect.succeed(yield* Config.Redacted(registration.tokenEnv))
          : mint !== undefined && github !== undefined
            ? mint(github)
            : Effect.succeed(undefined);
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
