import {
  GitHubAppConfig,
  gitHubRepo,
  installationTokens,
  type GitHubAppFailed,
  type GitHubRepo,
  type Permissions,
  type TokenCache,
} from "@dorbs/protocol/github-app";
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

/** One call to GitHub's REST API under /repos/{owner}/{name}; resolves with the decoded JSON body of a 2xx answer. */
export type GitHubApi = (
  repo: GitHubRepo,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Effect.Effect<unknown, GitHubFailed>;

/** The GitHub App as the agent may use it: per-repo credentials for github.com remotes, and the REST API. */
export class GitHub extends Context.Service<
  GitHub,
  {
    /**
     * Credentials for a github.com repo as request headers, for clone and push; none for any other
     * host or without the App. Rejects with GitHubFailed when the App cannot reach the repo.
     */
    readonly headers: (url: string) => Promise<Readonly<Record<string, string>> | undefined>;
    /** GitHub's REST API, or undefined without a GitHub App. */
    readonly api: GitHubApi | undefined;
  }
>()("dorbs/agent-worker/GitHub") {}

// The agent pushes branches and opens pull requests; it only reads issues.
const PERMISSIONS: Permissions = {
  contents: "write",
  pull_requests: "write",
  issues: "read",
  metadata: "read",
};

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

const make = Effect.fnUntraced(function* (tokens: TokenCache | undefined) {
  const app = yield* GitHubAppConfig;
  if (Option.isNone(app)) return { headers: async () => undefined, api: undefined };
  const mint = yield* installationTokens(app.value, PERMISSIONS, tokens);
  const token = (repo: GitHubRepo) =>
    mint(repo).pipe(Effect.mapError(({ reason }: GitHubAppFailed) => new GitHubFailed({ reason })));
  const base = app.value.apiUrl;

  const headers = async (url: string) => {
    const repo = gitHubRepo(url);
    if (repo === undefined) return undefined;
    const secret = await Effect.runPromise(token(repo));
    return { authorization: `Basic ${btoa(`x-access-token:${Redacted.value(secret)}`)}` };
  };

  const api: GitHubApi = Effect.fn("GitHub.api")(function* (repo, method, path, body) {
    const secret = yield* token(repo);
    const { status, ok, text } = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${base}/repos/${repo.owner}/${repo.name}${path}`, {
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
    });
    if (!ok) return yield* failure(status, text);
    return yield* Option.match(decodeJson(text), {
      onNone: () =>
        Effect.fail(new GitHubFailed({ reason: `${method} ${path} sent invalid JSON` })),
      onSome: Effect.succeed,
    });
  });

  return { headers, api };
});

/** Reads GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, optional, and GITHUB_API_URL, https://api.github.com by default. */
/** The GitHub App, keeping minted tokens in `tokens`, in memory when absent. */
export const layer = (tokens?: TokenCache) => Layer.effect(GitHub, make(tokens));
