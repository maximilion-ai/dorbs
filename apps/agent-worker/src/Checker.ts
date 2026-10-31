import {
  CheckResponse,
  TestResponse,
  type Change,
  type CheckId,
  type CheckRequest,
  type TestRequest,
} from "@dorbs/protocol/checker";
import type { CommitSha, RepoId } from "@dorbs/protocol/typecheck";
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
const decodeTest = Schema.decodeUnknownEffect(TestResponse);

const make = Effect.gen(function* () {
  const { url, token } = yield* CheckerConfig;
  const base = url.href.replace(/\/$/, "");
  const authorization = `Bearer ${Redacted.value(token)}`;

  const post = <A>(
    path: string,
    body: CheckRequest | TestRequest,
    decode: (json: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ) =>
    Effect.tryPromise({
      try: () =>
        fetch(`${base}${path}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { authorization, "content-type": "application/json" },
        }),
      catch: (cause) => new CheckFailed({ reason: `POST ${path} did not answer`, cause }),
    }).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) => new CheckFailed({ reason: `POST ${path} broke off`, cause }),
        }).pipe(
          Effect.filterOrFail(
            () => response.ok,
            (text) =>
              new CheckFailed({
                reason: `POST ${path} answered ${response.status}: ${text.slice(0, 2000)}`,
              }),
          ),
        ),
      ),
      Effect.flatMap((text) =>
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
