import {
  CheckResponse,
  Sha256,
  type CheckRequest,
  type CheckResult,
  type RelativePath,
} from "@dorbs/protocol/typecheck";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export type WorkspaceFile = { readonly path: RelativePath; readonly content: string };

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
      files: ReadonlyArray<WorkspaceFile>,
    ) => Effect.Effect<CheckResult, TypecheckFailed>;
  }
>()("dorbs/agent-worker/Typecheck") {}

const LOCKFILE = "pnpm-lock.yaml";

const TypecheckConfig = Config.all({
  url: Config.URL("TYPECHECK_URL"),
  token: Config.Redacted("TYPECHECK_TOKEN"),
});

const decodeCheckResponse = Schema.decodeUnknownEffect(CheckResponse);
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

  const post = (request: CheckRequest) =>
    send("POST", "/check", JSON.stringify(request), "application/json").pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) => new TypecheckFailed({ reason: "POST /check sent invalid JSON", cause }),
        }),
      ),
      Effect.flatMap((json) =>
        decodeCheckResponse(json).pipe(
          Effect.mapError(
            (cause) => new TypecheckFailed({ reason: "POST /check sent an unknown shape", cause }),
          ),
        ),
      ),
    );

  const check = Effect.fn("Typecheck.check")(function* (files: ReadonlyArray<WorkspaceFile>) {
    const blobs = new Map<Sha256, string>();
    const hashed = yield* Effect.forEach(files, (file) =>
      sha256(file.content).pipe(
        Effect.map((sha) => {
          blobs.set(sha, file.content);
          return { path: file.path, sha256: sha };
        }),
      ),
    );
    // The service installs dependencies per lockfile hash; a workspace without one shares the empty lockfile's.
    const lockText = files.find((file) => file.path === LOCKFILE)?.content ?? "";
    const lockfile = yield* sha256(lockText);
    blobs.set(lockfile, lockText);
    const request: CheckRequest = { lockfile, files: hashed };

    const first = yield* post(request);
    if (first._tag === "CheckResult") return first;
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
    const second = yield* post(request);
    if (second._tag === "CheckResult") return second;
    return yield* new TypecheckFailed({
      reason: `blobs still missing after upload: ${second.sha256s.join(", ")}`,
    });
  });

  return { check };
});

export const layer = Layer.effect(Typecheck, make);
