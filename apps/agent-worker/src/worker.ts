import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import type { WorkerEnv } from "../alchemy.run.ts";
import { makeAcpConnection } from "./AcpConnection.ts";
import * as ModelProvider from "./ModelProvider.ts";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Bound only for MODEL_PROVIDER=workers-ai. */
      readonly AI?: Ai;
    }
  }
}

export class AcpConnection extends makeAcpConnection((env) => ModelProvider.layer(env.AI)) {}

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/acp") return new Response("Not found", { status: 404 });
    const authorized = await Effect.runPromise(Effect.result(authorize(request, env)));
    if (authorized._tag === "Failure") {
      return new Response("AGENT_TOKEN is not configured", { status: 500 });
    }
    if (!authorized.success) return new Response("Unauthorized", { status: 401 });
    const connection = url.searchParams.get("connection");
    if (connection === null || connection === "") {
      return new Response("Missing ?connection=<id>", { status: 400 });
    }
    return env.AcpConnection.getByName(connection).fetch(request);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
