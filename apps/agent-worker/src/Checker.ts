import {
  ActionResponse,
  isProtectedPath,
  Sha256,
  ToolchainId,
  type Action,
  type ActionResult,
  type CommitSha,
  type Rejected,
  type RelativePath,
  type RepoId,
} from "@dorbs/protocol/typecheck";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export type WorkspaceFile = { readonly path: RelativePath; readonly content: string };

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

/** How a workspace differs from the commit it was cloned from. */
export type Change = {
  readonly files: ReadonlyArray<WorkspaceFile>;
  readonly deleted: ReadonlyArray<RelativePath>;
};

export class TypecheckFailed extends Schema.TaggedError<TypecheckFailed>()("TypecheckFailed", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Type check failed: ${this.reason}`;
  }
}

export class Typecheck extends Context.Service<
  Typecheck,
  {
    readonly check: (
      clone: Clone,
      change: Change,
    ) => Effect.Effect<ActionResult | Rejected, TypecheckFailed>;
  }
>()("dorbs/agent-worker/Typecheck") {}

const TypecheckConfig = Config.all({
  url: Config.URL("TYPECHECK_URL"),
  token: Config.Redacted("TYPECHECK_TOKEN"),
});

const decodeActionResponse = Schema.decodeUnknownEffect(ActionResponse);

// The one toolchain the typecheck service runs today.
const TOOLCHAIN = ToolchainId.make("node26-tsrs0.20-oxlint1.89");
const toSha256 = Schema.decodeSync(Sha256);

const sha256 = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) =>
      toSha256(Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")),
    ),
  );

const make = Effect.gen(function* () {
  const { url, token } = yield* TypecheckConfig;
  const base = url.href.replace(/\/$/, "");
  const authorization = `Bearer ${Redacted.value(token)}`;

  const send = (method: string, path: string, body: string, contentType: string) =>
    Effect.tryPromise({
      try: () =>
        fetch(`${base}${path}`, {
          method,
          body,
          headers: { authorization, "content-type": contentType },
        }),
      catch: (cause) => new TypecheckFailed({ reason: `${method} ${path} did not answer`, cause }),
    }).pipe(
      Effect.filterOrFail(
        (response) => response.ok,
        (response) =>
          new TypecheckFailed({ reason: `${method} ${path} answered ${response.status}` }),
      ),
    );

  const post = (action: Action) =>
    send("POST", "/actions", JSON.stringify(action), "application/json").pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) =>
            new TypecheckFailed({ reason: "POST /actions sent invalid JSON", cause }),
        }),
      ),
      Effect.flatMap((json) =>
        decodeActionResponse(json).pipe(
          Effect.mapError(
            (cause) =>
              new TypecheckFailed({ reason: "POST /actions sent an unknown shape", cause }),
          ),
        ),
      ),
    );

  const check = Effect.fn("Typecheck.check")(function* (clone: Clone, change: Change) {
    // The service would refuse these too; answering here skips the round trip.
    const touched = [...change.files.map((file) => file.path), ...change.deleted];
    const protectedPaths = touched.filter(isProtectedPath);
    if (protectedPaths.length > 0) {
      return {
        _tag: "Rejected",
        reason: { _tag: "ProtectedPaths", paths: protectedPaths },
      } satisfies Rejected;
    }
    const blobs = new Map<Sha256, string>();
    const hashed = yield* Effect.forEach(change.files, (file) =>
      sha256(file.content).pipe(
        Effect.map((sha) => {
          blobs.set(sha, file.content);
          return { path: file.path, sha256: sha };
        }),
      ),
    );
    const action: Action = {
      kind: "check",
      toolchain: TOOLCHAIN,
      repo: clone.repo,
      commit: clone.commit,
      files: hashed,
      deleted: change.deleted,
    };

    const first = yield* post(action);
    if (first._tag !== "MissingBlobs") return first;
    yield* Effect.forEach(
      first.sha256s,
      (sha) => {
        const blob = blobs.get(sha);
        return blob === undefined
          ? Effect.fail(new TypecheckFailed({ reason: `asked for unknown blob ${sha}` }))
          : send("PUT", `/blobs/${sha}`, blob, "application/octet-stream");
      },
      { concurrency: 8, discard: true },
    );
    const second = yield* post(action);
    if (second._tag !== "MissingBlobs") return second;
    return yield* new TypecheckFailed({
      reason: `blobs still missing after upload: ${second.sha256s.join(", ")}`,
    });
  });

  return { check };
});

export const layer = Layer.effect(Typecheck, make);
