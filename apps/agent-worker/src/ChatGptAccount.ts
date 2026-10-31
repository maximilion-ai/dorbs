import type { CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { DurableObject } from "cloudflare:workers";

const KEY = "credential";
/** Past pi-ai's own five-minute window, so a session always gets a token it will not try to refresh itself. */
const MIN_VALIDITY_MS = 10 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 30 * 1000;

/** What a session holds of the account: enough to send requests, not the refresh token. */
export type AccessCredential = {
  readonly type: "oauth";
  readonly access: string;
  readonly expires: number;
  readonly refresh: "";
};

// pi-ai loads OAuth flows through an import the bundler cannot follow, so a deployed Worker lacks them; this registers
// them as static imports, as pi-ai's own Bun binary does.
registerBunOAuthFlows();
const oauth = openaiProvider().auth.oauth;

/**
 * The ChatGPT subscription sessions on `MODEL_PROVIDER=chatgpt` sign in with, named "default". Only it refreshes the
 * OAuth token: OpenAI rotates the refresh token on every refresh, so two refreshers would log each other out.
 */
export class ChatGptAccount extends DurableObject {
  #refreshing: Promise<OAuthCredential> | undefined;

  /** Stores a credential from Sign in with ChatGPT, replacing the one before. */
  signIn(credential: OAuthCredential): void {
    this.ctx.storage.kv.put(KEY, credential);
  }

  /** A token valid for at least ten minutes, refreshed once for all sessions that ask meanwhile. */
  async access(): Promise<AccessCredential | undefined> {
    const stored = this.ctx.storage.kv.get<OAuthCredential>(KEY);
    if (stored === undefined) return undefined;
    const valid =
      Date.now() + MIN_VALIDITY_MS < stored.expires
        ? stored
        : await (this.#refreshing ??= this.#refresh(stored).finally(() => {
            this.#refreshing = undefined;
          }));
    return { type: "oauth", access: valid.access, expires: valid.expires, refresh: "" };
  }

  async #refresh(stored: OAuthCredential): Promise<OAuthCredential> {
    if (oauth === undefined) throw new Error("pi-ai's OpenAI provider has no OAuth");
    const refreshed = await oauth.refresh(stored, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
    this.ctx.storage.kv.put(KEY, refreshed);
    return refreshed;
  }
}

/**
 * The credential store a session's Pi reads the account through. Sessions never write: `modify` returns the account's
 * current token, which the account keeps valid, so pi-ai's refresh-under-lock never runs in a session.
 */
export const accountCredentials = (
  account: Pick<ChatGptAccount, "access">,
  providerId: string,
): CredentialStore => {
  const read = async (id: string) => {
    if (id !== providerId) return undefined;
    const credential = await account.access();
    if (credential === undefined) {
      throw new Error("ChatGPT is not connected; run `pnpm chatgpt-login` against this Worker");
    }
    return { ...credential };
  };
  return {
    read,
    list: async () => [{ providerId, type: "oauth" }],
    modify: read,
    delete: async () => {
      throw new Error("Sessions cannot sign the ChatGPT account out");
    },
  };
};
