import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
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
  /** A read token for one fetch: tokenEnv's, one the GitHub App mints for a github.com repo, or none. */
  readonly token: Effect.Effect<Redacted.Redacted | undefined, GitHubAppFailed>;
  /** The operator's .dorbs/check.json for the repo, as JSON, which wins over the repo's own. */
  readonly recipe: string | undefined;
};

export type Settings = {
  readonly dataDir: string;
  readonly token: Redacted.Redacted;
  readonly repos: ReadonlyMap<RepoId, Repo>;
  /** Bytes the environments may take on disk before the least recently used are evicted. */
  readonly diskBudget: number;
  /** How long a warm environment's container runs without a request before it is stopped. */
  readonly idleAfter: Duration.Duration;
  /** How long after a failed setup a request gets the failure again instead of a new setup. */
  readonly retrySetupAfter: Duration.Duration;
  readonly setupTimeout: Duration.Duration;
  readonly checkTimeout: Duration.Duration;
  readonly testTimeout: Duration.Duration;
  /** How many checks and tests run at once across environments; each environment runs one at a time. */
  readonly runSlots: number;
  readonly containerMemory: string;
  readonly setupMemory: string;
  readonly containerCpus: number;
  readonly containerPids: number;
  /**
   * How setup steps with network reach out: proxy, through an internal network whose only way out
   * is the registry-only egress proxy, or open, on Docker's default bridge.
   */
  readonly setupEgress: "proxy" | "open";
  /** The egress proxy's allowed hosts, comma-separated, a leading dot for a domain; its default list when unset. */
  readonly egressAllow: string | undefined;
};

export class ServiceConfig extends Context.Service<ServiceConfig, Settings>()(
  "dorbs/checker/ServiceConfig",
) {}

const Registrations = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: RepoId,
      url: Schema.NonEmptyString,
      /** Names the environment variable that holds the repo's read token. */
      tokenEnv: Schema.optionalKey(Schema.NonEmptyString),
      /** A public repo: fetched without a token, even when the GitHub App is set. */
      public: Schema.optionalKey(Schema.Boolean),
      /** A .dorbs/check.json for a repo the operator cannot commit one to. */
      recipe: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
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
    token: Config.schema(Schema.Redacted(Schema.NonEmptyString), "CHECK_TOKEN"),
    reposFile: Config.NonEmptyString("REPOS_FILE"),
    diskBudget: Config.Number("DISK_BUDGET").pipe(Config.withDefault(12 * 1024 ** 3)),
    idleAfter: Config.Duration("IDLE_AFTER").pipe(Config.withDefault(Duration.minutes(10))),
    retrySetupAfter: Config.Duration("RETRY_SETUP_AFTER").pipe(
      Config.withDefault(Duration.minutes(10)),
    ),
    setupTimeout: Config.Duration("SETUP_TIMEOUT").pipe(Config.withDefault(Duration.minutes(20))),
    checkTimeout: Config.Duration("CHECK_TIMEOUT").pipe(Config.withDefault(Duration.minutes(5))),
    testTimeout: Config.Duration("TEST_TIMEOUT").pipe(Config.withDefault(Duration.minutes(10))),
    runSlots: Config.Int("RUN_SLOTS").pipe(Config.withDefault(4)),
    containerMemory: Config.String("CONTAINER_MEMORY").pipe(Config.withDefault("8g")),
    setupMemory: Config.String("SETUP_MEMORY").pipe(Config.withDefault("8g")),
    containerCpus: Config.Number("CONTAINER_CPUS").pipe(Config.withDefault(4)),
    containerPids: Config.Int("CONTAINER_PIDS").pipe(Config.withDefault(2048)),
    setupEgress: Config.Literals(["proxy", "open"], "SETUP_EGRESS").pipe(
      Config.withDefault("proxy" as const),
    ),
    egressAllow: Config.String("EGRESS_ALLOW").pipe(Config.withDefault("")),
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
          : registration.public !== true && mint !== undefined && github !== undefined
            ? mint(github)
            : Effect.succeed(undefined);
      return {
        id: registration.id,
        url: registration.url,
        token,
        recipe: registration.recipe === undefined ? undefined : JSON.stringify(registration.recipe),
      } satisfies Repo;
    }),
  );
  return {
    dataDir: config.dataDir,
    token: config.token,
    repos: new Map(repos.map((repo) => [repo.id, repo])),
    diskBudget: config.diskBudget,
    idleAfter: config.idleAfter,
    retrySetupAfter: config.retrySetupAfter,
    setupTimeout: config.setupTimeout,
    checkTimeout: config.checkTimeout,
    testTimeout: config.testTimeout,
    runSlots: config.runSlots,
    containerMemory: config.containerMemory,
    setupMemory: config.setupMemory,
    containerCpus: config.containerCpus,
    containerPids: config.containerPids,
    setupEgress: config.setupEgress,
    egressAllow: config.egressAllow === "" ? undefined : config.egressAllow,
  } satisfies Settings;
});

export const layer = Layer.effect(ServiceConfig, make);
