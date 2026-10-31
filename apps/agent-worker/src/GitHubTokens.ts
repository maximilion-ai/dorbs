import type { CachedToken, TokenCache } from "@dorbs/protocol/github-app";
import { DurableObject } from "cloudflare:workers";

/**
 * The GitHub App's minted tokens, kept for every session in one object reached by name. A session's own cache dies
 * with it, and each session runs in its own isolate, so every session's first clone minted a token: two GitHub calls.
 */
export class GitHubTokens extends DurableObject {
  get(key: string): CachedToken | undefined {
    return this.ctx.storage.kv.get<CachedToken>(key);
  }

  set(key: string, entry: CachedToken): void {
    this.ctx.storage.kv.put(key, entry);
  }
}

export const tokenCache = (namespace: DurableObjectNamespace<GitHubTokens>): TokenCache => {
  const tokens = namespace.getByName("tokens");
  return { get: (key) => tokens.get(key), set: (key, entry) => tokens.set(key, entry) };
};
