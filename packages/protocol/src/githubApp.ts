// A GitHub App's installation tokens, for the agent Worker and the typecheck service alike: WebCrypto
// and fetch only, so it runs in workerd and Node.

import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** A repo on github.com. */
export type GitHubRepo = { readonly owner: string; readonly name: string };

const GITHUB_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u;

/** The github.com repo `url` names, or undefined for any other url. */
export const gitHubRepo = (url: string): GitHubRepo | undefined => {
  const [, owner, name] = GITHUB_URL.exec(url) ?? [];
  return owner === undefined || name === undefined ? undefined : { owner, name };
};

export class GitHubAppFailed extends Schema.TaggedError<GitHubAppFailed>()("GitHubAppFailed", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

/** The App a service acts as, and the API it reaches GitHub through. */
export type GitHubApp = {
  readonly id: string;
  /** PKCS#8 PEM: -----BEGIN PRIVATE KEY-----. */
  readonly privateKey: Redacted.Redacted;
  readonly apiUrl: string;
};

/**
 * Reads GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, both set or both empty for no App, and GITHUB_API_URL,
 * https://api.github.com by default.
 */
export const GitHubAppConfig: Config.Config<Option.Option<GitHubApp>> = Config.all({
  id: Config.String("GITHUB_APP_ID").pipe(Config.withDefault("")),
  privateKey: Config.Redacted("GITHUB_APP_PRIVATE_KEY").pipe(Config.withDefault(Redacted.make(""))),
  apiUrl: Config.URL("GITHUB_API_URL").pipe(Config.withDefault(new URL("https://api.github.com"))),
}).pipe(
  Config.flatMap(({ id, privateKey, apiUrl }) => {
    const keyed = Redacted.value(privateKey) !== "";
    if (id === "" && !keyed) return Config.succeed(Option.none());
    if (id === "" || !keyed) {
      return Config.fail(
        new ConfigProvider.SourceError({
          message: "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are set together or not at all",
        }),
      );
    }
    return Config.succeed(Option.some({ id, privateKey, apiUrl: apiUrl.href.replace(/\/$/u, "") }));
  }),
);

/** What an installation token may do, by GitHub's permission names, such as `{ contents: "read" }`. */
export type Permissions = Readonly<Record<string, "read" | "write">>;

const Installation = Schema.Struct({ id: Schema.Number });
const AccessToken = Schema.Struct({ token: Schema.String, expires_at: Schema.String });
const decodeInstallation = Schema.decodeUnknownOption(Schema.fromJsonString(Installation));
const decodeAccessToken = Schema.decodeUnknownOption(Schema.fromJsonString(AccessToken));
const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
);

const PKCS8 = /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/u;
// A token this close to its expires_at is not handed out: a clone or push may outlast the rest.
const REFRESH_MARGIN_MS = 5 * 60_000;

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");

const jsonSegment = (value: unknown): string =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));

const signingKey = Effect.fn("GitHubApp.signingKey")(function* (app: GitHubApp) {
  const body = PKCS8.exec(Redacted.value(app.privateKey).trim())?.[1];
  if (body === undefined) {
    return yield* new GitHubAppFailed({
      reason:
        "GITHUB_APP_PRIVATE_KEY is not a PKCS#8 PEM key (-----BEGIN PRIVATE KEY-----). " +
        "Convert GitHub's key with openssl pkcs8 -topk8 -nocrypt.",
    });
  }
  const der = Uint8Array.from(atob(body.replace(/\s/gu, "")), (c) => c.charCodeAt(0));
  return yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "sign",
      ]),
    catch: () => new GitHubAppFailed({ reason: "GITHUB_APP_PRIVATE_KEY is not an RSA key" }),
  });
});

/**
 * The installation tokens of `app` with `permissions`: each narrowed to one repo, and reused until
 * five minutes before it expires.
 */
export const installationTokens = Effect.fn("GitHubApp.installationTokens")(function* (
  app: GitHubApp,
  permissions: Permissions,
) {
  const key = yield* Effect.cached(signingKey(app));
  const cache = new Map<
    string,
    { readonly token: Redacted.Redacted; readonly refreshAt: number }
  >();

  // GitHub refuses an App JWT that lives over ten minutes; iat sits a minute back for clock drift.
  const jwt = Effect.fn("GitHubApp.jwt")(function* (nowMs: number) {
    const now = Math.floor(nowMs / 1000);
    const unsigned = `${jsonSegment({ alg: "RS256", typ: "JWT" })}.${jsonSegment({
      iat: now - 60,
      exp: now + 540,
      iss: app.id,
    })}`;
    const signing = yield* key;
    const signature = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.sign("RSASSA-PKCS1-v1_5", signing, new TextEncoder().encode(unsigned)),
      catch: () => new GitHubAppFailed({ reason: "Signing the GitHub App JWT failed" }),
    });
    return `${unsigned}.${base64url(new Uint8Array(signature))}`;
  });

  const call = (bearer: string, method: "GET" | "POST", path: string, body?: unknown) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${app.apiUrl}${path}`, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${bearer}`,
            "user-agent": "dorbs",
            "x-github-api-version": "2022-11-28",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, text: await response.text() };
      },
      catch: (cause) =>
        new GitHubAppFailed({
          reason: `${app.apiUrl} did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });

  const refused = (what: string, status: number, text: string) =>
    new GitHubAppFailed({
      reason: `GitHub refused ${what}: HTTP ${status}: ${Option.match(decodeErrorBody(text), {
        onNone: () => text.trim() || "no message",
        onSome: (body) => body.message,
      })}`,
    });

  // Decode failures name no value: the body holds the token.
  const unknownShape = (what: string) =>
    new GitHubAppFailed({ reason: `GitHub answered ${what} with an unknown shape` });

  return Effect.fn("GitHubApp.token")(function* (repo: GitHubRepo) {
    const now = yield* Clock.currentTimeMillis;
    const id = `${repo.owner}/${repo.name}`;
    const cached = cache.get(id);
    if (cached !== undefined && now < cached.refreshAt) return cached.token;
    const bearer = yield* jwt(now);
    const found = yield* call(
      bearer,
      "GET",
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/installation`,
    );
    if (found.status === 404) {
      return yield* new GitHubAppFailed({
        reason: `The GitHub App is not installed on ${id}. Install it on the repo to give the agent access.`,
      });
    }
    if (found.status !== 200)
      return yield* refused(`the installation of ${id}`, found.status, found.text);
    const installation = yield* Effect.fromOption(decodeInstallation(found.text)).pipe(
      Effect.mapError(() => unknownShape(`the installation of ${id}`)),
    );
    const minted = yield* call(
      bearer,
      "POST",
      `/app/installations/${installation.id}/access_tokens`,
      {
        repositories: [repo.name],
        permissions,
      },
    );
    if (minted.status !== 201)
      return yield* refused(`a token for ${id}`, minted.status, minted.text);
    const answer = yield* Effect.fromOption(decodeAccessToken(minted.text)).pipe(
      Effect.mapError(() => unknownShape(`a token for ${id}`)),
    );
    const token = Redacted.make(answer.token);
    cache.set(id, { token, refreshAt: Date.parse(answer.expires_at) - REFRESH_MARGIN_MS });
    return token;
  });
});
