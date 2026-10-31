import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { CommitSha, RelativePath, RepoId } from "@dorbs/protocol/typecheck";

import { isDetectionInput } from "./detect.ts";
import { runProcess } from "./runProcess.ts";
import { type Repo, ServiceConfig } from "./ServiceConfig.ts";

export class UnknownCommit extends Schema.TaggedError<UnknownCommit>()("UnknownCommit", {
  repo: RepoId,
  commit: CommitSha,
}) {
  override get message(): string {
    return `${this.repo} has no commit ${this.commit}`;
  }
}

export class FetchFailed extends Schema.TaggedError<FetchFailed>()("FetchFailed", {
  repo: RepoId,
  output: Schema.String,
}) {
  override get message(): string {
    return `git fetch from ${this.repo} failed:\n${this.output}`;
  }
}

/** A commit's paths and the content of the files detection reads. */
export type CommitFiles = {
  readonly paths: ReadonlyArray<RelativePath>;
  readonly inputs: ReadonlyMap<string, string>;
};

export class Git extends Context.Service<
  Git,
  {
    /** Fetches `commit` into the repo's bare cache unless it holds it already; answers the cache. */
    readonly fetch: (
      repo: Repo,
      commit: CommitSha,
    ) => Effect.Effect<string, UnknownCommit | FetchFailed>;
    readonly files: (gitDir: string, commit: CommitSha) => Effect.Effect<CommitFiles>;
  }
>()("dorbs/checker/Git") {}

// No user or system config, so no credential helper, and no prompt: a fetch has its token or fails.
const gitEnv = (token: Redacted.Redacted | undefined): Record<string, string> => ({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  // In the environment rather than `-c`, so the token is on no command line.
  ...(token === undefined
    ? {}
    : {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${Redacted.value(token)}`).toString("base64")}`,
      }),
});

const isRelativePath = Schema.is(RelativePath);

/** Reads `git cat-file --batch` output: a header line, the object's bytes and a newline, per input. */
const readBatch = (output: Buffer, names: ReadonlyArray<string>): Map<string, string> => {
  const files = new Map<string, string>();
  let at = 0;
  for (const name of names) {
    const newline = output.indexOf(10, at);
    if (newline === -1) break;
    const header = output.subarray(at, newline).toString();
    at = newline + 1;
    const size = /^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1];
    if (size === undefined) continue;
    files.set(name, output.subarray(at, at + Number(size)).toString());
    at += Number(size) + 1;
  }
  return files;
};

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { dataDir } = yield* ServiceConfig;
  const caches = NodePath.join(dataDir, "git");
  // Fetches into one repo's cache take turns, because git locks the cache's shallow file.
  const turns = new Map<RepoId, Semaphore.Semaphore>();
  const turn = (repo: RepoId) => {
    const existing = turns.get(repo) ?? Semaphore.makeUnsafe(1);
    turns.set(repo, existing);
    return existing;
  };

  const git = (
    cwd: string,
    args: ReadonlyArray<string>,
    env: Record<string, string> = gitEnv(undefined),
  ) => runProcess(spawner, cwd, "git", args, { env, timeout: "10 minutes" }).pipe(Effect.orDie);

  const fetch: Git["Service"]["fetch"] = Effect.fn("Git.fetch")(function* (repo, commit) {
    const gitDir = NodePath.join(caches, `${repo.id}.git`);
    return yield* turn(repo.id).withPermit(
      Effect.gen(function* () {
        yield* Effect.promise(() => NodeFSP.mkdir(gitDir, { recursive: true }));
        if ((yield* git(gitDir, ["rev-parse", "--is-bare-repository"])).exitCode !== 0) {
          yield* git(gitDir, ["init", "--bare", "--quiet"]);
        }
        const present = yield* git(gitDir, ["cat-file", "-e", `${commit}^{commit}`]);
        if (present.exitCode === 0) return gitDir;
        const token = yield* repo.token.pipe(
          Effect.mapError((error) => new FetchFailed({ repo: repo.id, output: error.message })),
        );
        const result = yield* git(
          gitDir,
          [
            "fetch",
            "--quiet",
            "--depth",
            "1",
            "--no-tags",
            "--no-write-fetch-head",
            repo.url,
            commit,
          ],
          gitEnv(token),
        );
        if (result.exitCode !== 0) {
          return yield* /not our ref|couldn't find remote ref|unadvertised object/i.test(
            result.stderr,
          )
            ? new UnknownCommit({ repo: repo.id, commit })
            : new FetchFailed({ repo: repo.id, output: result.stderr.slice(-4000) });
        }
        return gitDir;
      }),
    );
  });

  const files: Git["Service"]["files"] = Effect.fn("Git.files")(function* (gitDir, commit) {
    const listed = yield* git(gitDir, ["ls-tree", "-r", "-z", "--name-only", commit]);
    if (listed.exitCode !== 0)
      return yield* Effect.die(new Error(`git ls-tree failed: ${listed.stderr}`));
    const paths = listed.stdout.split("\0").filter(isRelativePath);
    const wanted = paths.filter(isDetectionInput);
    const output = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("git", ["cat-file", "--batch"], {
            cwd: gitDir,
            env: { PATH: process.env["PATH"] ?? "", ...gitEnv(undefined) },
            extendEnv: false,
            stdin: Stream.make(
              new TextEncoder().encode(wanted.map((path) => `${commit}:${path}\n`).join("")),
            ),
          }),
        );
        const chunks = yield* Stream.runCollect(handle.stdout);
        yield* handle.exitCode;
        return Buffer.concat([...chunks]);
      }),
    ).pipe(Effect.orDie);
    return { paths, inputs: readBatch(output, wanted) };
  });

  return Git.of({ fetch, files });
});

export const layer = Layer.effect(Git, make);
