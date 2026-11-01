import {
  CheckResponse,
  TestResponse,
  type Change,
  type CheckId,
  type CheckRequest,
  type TestRequest,
} from "@dorbs/protocol/checker";
import type { CommitSha, RepoId } from "@dorbs/protocol/checker";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export type { Change };

/**
 * The repo and commit a workspace was cloned from, the base branch checked out then, and the branches the
 * session's pushes created on origin, which later pushes may move.
 */
export type Clone = {
  readonly repo: RepoId;
  readonly commit: CommitSha;
  readonly branch: string;
  readonly created?: ReadonlyArray<string>;
  /** The R2 prefix of the base the workspace reads untouched files from. */
  readonly base?: string;
};

/** Which tests a test call runs: files, or for pytest test ids, and a name filter. */
export type TestSelection = { readonly files?: ReadonlyArray<string>; readonly filter?: string };

export class CheckFailed extends Schema.TaggedError<CheckFailed>()("CheckFailed", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `The checker failed: ${this.reason}`;
  }
}

export class Checker extends Context.Service<
  Checker,
  {
    readonly check: (
      clone: Clone,
      change: Change,
      only: ReadonlyArray<CheckId> | undefined,
    ) => Effect.Effect<CheckResponse, CheckFailed>;
    readonly test: (
      clone: Clone,
      change: Change,
      selection: TestSelection,
    ) => Effect.Effect<TestResponse, CheckFailed>;
  }
>()("dorbs/agent-worker/Checker") {}

const CheckerConfig = Config.all({
  url: Config.URL("CHECK_URL"),
  token: Config.Redacted("CHECK_TOKEN"),
});

const decodeCheck = Schema.decodeUnknownEffect(CheckResponse);
const POLL = "2 seconds";
const JOB_DEADLINE_MS = 30 * 60 * 1000;
const decodeTest = Schema.decodeUnknownEffect(TestResponse);

const make = Effect.gen(function* () {
  const { url, token } = yield* CheckerConfig;
  const base = url.href.replace(/\/$/, "");
  const authorization = `Bearer ${Redacted.value(token)}`;

  const request = (method: "GET" | "POST", path: string, body?: CheckRequest | TestRequest) =>
    Effect.tryPromise({
      try: () =>
        fetch(`${base}${path}`, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: { authorization, "content-type": "application/json" },
        }),
      catch: (cause) => new CheckFailed({ reason: `${method} ${path} did not answer`, cause }),
    }).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: async () => ({ status: response.status, text: await response.text() }),
          catch: (cause) => new CheckFailed({ reason: `${method} ${path} broke off`, cause }),
        }),
      ),
    );

  /**
   * Runs a check or test as a checker job and polls for its answer: a proxy in front of the checker, such as a
   * Cloudflare tunnel, cuts off a request after 100 s, and a busy checker queues runs for longer. A checker without
   * jobs answers 404, and the run goes to the plain endpoint.
   */
  const run = (path: string, body: CheckRequest | TestRequest) =>
    request("POST", `/jobs${path}`, body).pipe(
      Effect.flatMap(({ status, text }) => {
        if (status === 404) return request("POST", path, body);
        if (status !== 202) return Effect.succeed({ status, text });
        const id = Effect.try({
          try: (): string => JSON.parse(text).id,
          catch: (cause) => new CheckFailed({ reason: `POST /jobs${path} sent no job id`, cause }),
        });
        const poll = (
          jobId: string,
          deadline: number,
        ): Effect.Effect<{ status: number; text: string }, CheckFailed> =>
          Effect.sleep(POLL).pipe(
            Effect.andThen(request("GET", `/jobs/${jobId}`)),
            Effect.flatMap((answer) => {
              if (answer.status !== 202) return Effect.succeed(answer);
              if (Date.now() > deadline) {
                return Effect.fail(
                  new CheckFailed({ reason: `${path} did not finish within 30 minutes` }),
                );
              }
              return poll(jobId, deadline);
            }),
          );
        return id.pipe(Effect.flatMap((jobId) => poll(jobId, Date.now() + JOB_DEADLINE_MS)));
      }),
    );

  const post = <A>(
    path: string,
    body: CheckRequest | TestRequest,
    decode: (json: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ) =>
    run(path, body).pipe(
      Effect.filterOrFail(
        ({ status }) => status >= 200 && status < 300,
        ({ status, text }) =>
          new CheckFailed({ reason: `POST ${path} answered ${status}: ${text.slice(0, 2000)}` }),
      ),
      Effect.flatMap(({ text }) =>
        Effect.try({
          try: (): unknown => JSON.parse(text),
          catch: (cause) => new CheckFailed({ reason: `POST ${path} sent invalid JSON`, cause }),
        }),
      ),
      Effect.flatMap((json) =>
        decode(json).pipe(
          Effect.mapError(
            (cause) => new CheckFailed({ reason: `POST ${path} sent an unknown shape`, cause }),
          ),
        ),
      ),
    );

  const check: Checker["Service"]["check"] = (clone, change, only) =>
    post(
      "/check",
      { repo: clone.repo, commit: clone.commit, change, ...(only === undefined ? {} : { only }) },
      decodeCheck,
    );

  const test: Checker["Service"]["test"] = (clone, change, selection) =>
    post(
      "/test",
      {
        repo: clone.repo,
        commit: clone.commit,
        change,
        ...(selection.files === undefined ? {} : { files: selection.files }),
        ...(selection.filter === undefined ? {} : { filter: selection.filter }),
      },
      decodeTest,
    );

  return { check, test };
});

export const layer = Layer.effect(Checker, make);
