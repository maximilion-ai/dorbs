import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { WorkerEnv } from "../alchemy.run.ts";
import { makeAcpSession } from "./AcpSession.ts";
import * as ModelProvider from "./ModelProvider.ts";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Bound only for MODEL_PROVIDER=workers-ai. */
      readonly AI?: Ai;
    }
  }
}

export { AcpConnection } from "./AcpConnection.ts";
export { GitHubTokens } from "./GitHubTokens.ts";
export { ChatGptAccount } from "./ChatGptAccount.ts";
export class AcpSession extends makeAcpSession((env) => ModelProvider.layer(env)) {}

const AgentToken = Config.Redacted("AGENT_TOKEN");
const encoder = new TextEncoder();

const sameSecret = (given: string, expected: string): boolean => {
  const a = encoder.encode(given);
  const b = encoder.encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
};

const authorize = (request: Request, env: Cloudflare.Env) =>
  AgentToken.parse(ConfigProvider.fromUnknown(env)).pipe(
    Effect.map((token) =>
      sameSecret(request.headers.get("Authorization") ?? "", `Bearer ${Redacted.value(token)}`),
    ),
  );

/** What Sign in with ChatGPT returns; the account refreshes it with the client id OpenAI issued at login. */
const decodeChatGptCredential = Schema.decodeUnknownOption(
  Schema.StructWithRest(
    Schema.Struct({
      type: Schema.Literal("oauth"),
      access: Schema.NonEmptyString,
      refresh: Schema.NonEmptyString,
      expires: Schema.Number,
      clientId: Schema.NonEmptyString,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
);

/** Signs the Worker's ChatGPT account in with a credential `pnpm chatgpt-login` posts. */
const connectChatGpt = async (request: Request, env: Cloudflare.Env): Promise<Response> => {
  if (request.method !== "POST") return new Response("Expected POST", { status: 405 });
  const credential = decodeChatGptCredential(await request.json().catch(() => undefined));
  if (credential._tag === "None") return new Response("Not a ChatGPT credential", { status: 400 });
  await env.ChatGptAccount.getByName("default").signIn(credential.value);
  return new Response(null, { status: 204 });
};

const decodeSessionIds = Schema.decodeUnknownOption(
  Schema.Struct({ sessions: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(100)) }),
);

/** Deletes the named sessions at once, rather than after the retention period. */
const purgeSessions = async (request: Request, env: Cloudflare.Env): Promise<Response> => {
  if (request.method !== "POST") return new Response("Expected POST", { status: 405 });
  const body = decodeSessionIds(await request.json().catch(() => undefined));
  if (body._tag === "None")
    return new Response("Expected { sessions: string[] } of at most 100", { status: 400 });
  // Purging aborts the object, so its call fails once the storage is gone; that failure is the success.
  await Promise.all(
    body.value.sessions.map((id) =>
      env.AcpSession.getByName(id)
        .purge()
        .catch(() => undefined),
    ),
  );
  return Response.json({ purged: body.value.sessions.length });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname !== "/acp" &&
      url.pathname !== "/chatgpt/connect" &&
      url.pathname !== "/sessions/purge"
    ) {
      return new Response("Not found", { status: 404 });
    }
    const authorized = await Effect.runPromise(Effect.result(authorize(request, env)));
    if (authorized._tag === "Failure") {
      return new Response("AGENT_TOKEN is not configured", { status: 500 });
    }
    if (!authorized.success) return new Response("Unauthorized", { status: 401 });
    if (url.pathname === "/chatgpt/connect") return connectChatGpt(request, env);
    if (url.pathname === "/sessions/purge") return purgeSessions(request, env);
    const connection = url.searchParams.get("connection");
    if (connection === null || connection === "") {
      return new Response("Missing ?connection=<id>", { status: 400 });
    }
    return env.AcpConnection.getByName(connection).fetch(request);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
