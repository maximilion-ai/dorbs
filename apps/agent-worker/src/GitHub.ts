import type { AuthCallback } from "@cloudflare/computer/git";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class GitHubFailed extends Schema.TaggedError<GitHubFailed>()("GitHubFailed", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

/** One call to GitHub's REST API; resolves with the decoded JSON body of a 2xx answer. */
export type GitHubApi = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Effect.Effect<unknown, GitHubFailed>;

/** GITHUB_TOKEN as the agent may use it: git credentials for github.com remotes, and the REST API. */
export class GitHub extends Context.Service<
  GitHub,
  {
    /** Credentials for a github.com remote, and none for any other host. */
    readonly onAuth: AuthCallback;
    /** The same credentials as request headers, for clone, which takes no onAuth. */
    readonly headers: (url: string) => Readonly<Record<string, string>> | undefined;
    /** GitHub's REST API, or undefined without a GITHUB_TOKEN. */
    readonly api: GitHubApi | undefined;
  }
>()("dorbs/agent-worker/GitHub") {}

const GitHubConfig = Config.all({
  token: Config.option(Config.Redacted("GITHUB_TOKEN")),
  apiUrl: Config.URL("GITHUB_API_URL").pipe(Config.withDefault(new URL("https://api.github.com"))),
});

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const ErrorBody = Schema.Struct({
  message: Schema.String,
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        message: Schema.optionalKey(Schema.String),
        field: Schema.optionalKey(Schema.String),
        code: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));

/** GitHub's own words for a failed call, as gh prints them: `HTTP 422: Validation Failed (...)`. */
const failure = (status: number, text: string): GitHubFailed => {
  const body = Option.getOrUndefined(decodeErrorBody(text));
  const details = (body?.errors ?? []).map(
    (error) => error.message ?? [error.field, error.code].filter(Boolean).join(" "),
  );
  return new GitHubFailed({
    reason:
      `HTTP ${status}: ${body?.message ?? (text.trim() || "no message")}` +
      (details.length === 0 ? "" : ` (${details.join("; ")})`),
  });
};

const make = Effect.gen(function* () {
  const config = yield* GitHubConfig;
  // A deploy without the secret binds it empty.
  const token = Option.filter(config.token, (secret) => Redacted.value(secret) !== "");
  const base = config.apiUrl.href.replace(/\/$/, "");

  const onAuth: AuthCallback = (url) =>
    Option.isSome(token) && new URL(url).hostname === "github.com"
      ? { username: "x-access-token", password: Redacted.value(token.value) }
      : undefined;

  const headers = (url: string) => {
    const auth = onAuth(url, {});
    return auth === undefined || auth instanceof Promise
      ? undefined
      : { authorization: `Basic ${btoa(`${auth.username}:${auth.password}`)}` };
  };

  const api = Option.map(
    token,
    (secret): GitHubApi =>
      (method, path, body) =>
        Effect.tryPromise({
          try: async () => {
            const response = await fetch(`${base}${path}`, {
              method,
              headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${Redacted.value(secret)}`,
                "user-agent": "dorbs",
                "x-github-api-version": "2022-11-28",
                ...(body === undefined ? {} : { "content-type": "application/json" }),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, ok: response.ok, text: await response.text() };
          },
          catch: (cause) =>
            new GitHubFailed({
              reason: `${base} did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        }).pipe(
          Effect.flatMap(({ status, ok, text }) => {
            if (!ok) return Effect.fail(failure(status, text));
            return Option.match(decodeJson(text), {
              onNone: () =>
                Effect.fail(new GitHubFailed({ reason: `${method} ${path} sent invalid JSON` })),
              onSome: Effect.succeed,
            });
          }),
        ),
  );

  return { onAuth, headers, api: Option.getOrUndefined(api) };
});

/** Reads GITHUB_TOKEN, optional, and GITHUB_API_URL, https://api.github.com by default. */
export const layer = Layer.effect(GitHub, make);
