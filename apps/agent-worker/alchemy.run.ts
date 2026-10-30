import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Secrets from "alchemy/Secrets";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import type { AcpConnection, AcpSession } from "./src/worker.ts";

export const Worker = Cloudflare.Worker("AgentWorker", {
  main: "./src/worker.ts",
  compatibility: { date: "2026-10-01", flags: ["nodejs_compat"] },
  env: {
    AcpConnection: Cloudflare.DurableObject<AcpConnection>("AcpConnection"),
    AcpSession: Cloudflare.DurableObject<AcpSession>("AcpSession"),
    AGENT_TOKEN: Config.Redacted("AGENT_TOKEN"),
    TYPECHECK_URL: Config.String("TYPECHECK_URL"),
    TYPECHECK_TOKEN: Config.Redacted("TYPECHECK_TOKEN"),
    REPOS: Config.String("REPOS"),
    // The agent loop new sessions run on: pi or opencode.
    HARNESS: Config.String("HARNESS").pipe(Config.withDefault("pi")),
    MODEL_PROVIDER: Config.String("MODEL_PROVIDER"),
    MODEL_ID: Config.String("MODEL_ID"),
    OPENROUTER_API_KEY: Config.Redacted("OPENROUTER_API_KEY"),
    // Optional; empty means no GitHub App, since an undefined default sends alchemy's env inference into a loop.
    GITHUB_APP_ID: Config.String("GITHUB_APP_ID").pipe(Config.withDefault("")),
    GITHUB_APP_PRIVATE_KEY: Config.Redacted("GITHUB_APP_PRIVATE_KEY").pipe(
      Config.withDefault(Redacted.make("")),
    ),
    GITHUB_API_URL: Config.String("GITHUB_API_URL").pipe(
      Config.withDefault("https://api.github.com"),
    ),
    // Days a session may sit idle before its history, workspace and Pi session are deleted.
    SESSION_RETENTION_DAYS: Config.String("SESSION_RETENTION_DAYS").pipe(Config.withDefault("30")),
    ALCHEMY_DEV: Alchemy.ALCHEMY_DEV,
  },
  dev: { port: 8787 },
});

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export default Alchemy.Stack(
  "AgentWorker",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
    secrets: [Secrets.DotEnv(), Secrets.ProcessEnv()],
  },
  Effect.gen(function* () {
    return { url: (yield* Worker).url };
  }),
);
