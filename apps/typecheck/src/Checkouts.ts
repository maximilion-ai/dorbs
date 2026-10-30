import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { CommitSha, RelativePath, RepoId, Sha256 } from "@dorbs/protocol/typecheck";

import { runProcess } from "./runProcess.ts";
import { type Repo, ServiceConfig } from "./ServiceConfig.ts";
import * as SingleFlight from "./SingleFlight.ts";
import { Storage } from "./Storage.ts";
import { tsconfigChain } from "./tsconfigChain.ts";

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

/** A clean tree of one registered repo at one commit, shared read-only by every check of it. */
export type Checkout = {
  readonly dir: string;
  /** Directories, relative to `dir`, that hold a package.json; "." is the root. */
  readonly packages: ReadonlyArray<string>;
  /** SHA-256 of pnpm-lock.yaml, or of the empty string when the commit has none. */
  readonly lockfile: Sha256;
  /** The tsconfig files the commit's tsconfig.json extends or references, by any name. */
  readonly tsconfigs: ReadonlySet<RelativePath>;
  /** Options in those files that write files or reach outside the repo, as `path: option`. */
  readonly unsafeConfig: ReadonlyArray<string>;
  /** The package manager the root package.json's `packageManager` pins, by name. */
  readonly packageManager: string | undefined;
};

export class Checkouts extends Context.Service<
  Checkouts,
  {
    readonly ensure: (
      repo: Repo,
      commit: CommitSha,
    ) => Effect.Effect<Checkout, UnknownCommit | FetchFailed>;
  }
>()("dorbs/typecheck/Checkouts") {}

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

const sha256 = (content: Uint8Array) =>
  Sha256.make(NodeCrypto.createHash("sha256").update(content).digest("hex"));

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { dataDir, processTimeout } = yield* ServiceConfig;
  const caches = path.join(dataDir, "git");
  const trees = path.join(dataDir, "checkouts");
  yield* fs.makeDirectory(trees, { recursive: true });
  const storage = yield* Storage;
  // A tree sits at checkouts/<owner>/<name>/<commit>, since a repo id has one slash.
  const listed = (dir: string) =>
    fs
      .readDirectory(dir)
      .pipe(
        Effect.map((names) =>
          names.filter((name) => !name.startsWith(".")).map((name) => path.join(dir, name)),
        ),
      );
  const owners = yield* listed(trees);
  const names = (yield* Effect.forEach(owners, listed)).flat();
  yield* storage.adopt((yield* Effect.forEach(names, listed)).flat());
  const once = yield* SingleFlight.make<Checkout, UnknownCommit | FetchFailed>({
    keep: 256,
    // Eviction may have removed the tree since.
    valid: (checkout) => fs.exists(checkout.dir).pipe(Effect.orElseSucceed(() => false)),
  });
  // Fetches into one repo's cache take turns, because git locks the cache's shallow file.
  const fetchTurns = new Map<RepoId, Semaphore.Semaphore>();
  const fetchTurn = (repo: RepoId) => {
    const turn = fetchTurns.get(repo) ?? Semaphore.makeUnsafe(1);
    fetchTurns.set(repo, turn);
    return turn;
  };

  const run = Effect.fn("Checkouts.run")(function* (
    cwd: string,
    command: string,
    args: ReadonlyArray<string>,
    env: Record<string, string> = {},
  ) {
    const result = yield* runProcess(spawner, cwd, command, args, {
      env,
      timeout: processTimeout,
    }).pipe(Effect.orDie);
    if (result.exitCode !== 0) {
      yield* Effect.die(
        new Error(`${command} ${args[0]} exited ${result.exitCode}: ${result.stderr}`),
      );
    }
  });

  const fetch = Effect.fn("Checkouts.fetch")(function* (
    repo: Repo,
    commit: CommitSha,
    cache: string,
  ) {
    if (!(yield* fs.exists(cache).pipe(Effect.orDie))) {
      yield* fs.makeDirectory(cache, { recursive: true }).pipe(Effect.orDie);
      yield* run(cache, "git", ["init", "--bare", "--quiet"], gitEnv(undefined));
    }
    const token = yield* repo.token.pipe(
      Effect.mapError((error) => new FetchFailed({ repo: repo.id, output: error.message })),
    );
    const result = yield* runProcess(
      spawner,
      cache,
      "git",
      ["fetch", "--quiet", "--depth", "1", "--no-tags", "--no-write-fetch-head", repo.url, commit],
      { env: gitEnv(token), timeout: processTimeout },
    ).pipe(
      Effect.catchTags({
        PlatformError: Effect.die,
        ProcessFailed: (error) =>
          Effect.fail(new FetchFailed({ repo: repo.id, output: error.message })),
      }),
    );
    if (result.exitCode !== 0) {
      yield* Effect.fail(
        result.stderr.includes("not our ref")
          ? new UnknownCommit({ repo: repo.id, commit })
          : new FetchFailed({ repo: repo.id, output: result.stderr.slice(-4000) }),
      );
    }
  });

  const materialize = Effect.fn("Checkouts.materialize")(function* (repo: Repo, commit: CommitSha) {
    const dir = path.join(trees, repo.id, commit);
    if (yield* fs.exists(dir).pipe(Effect.orDie)) return dir;
    const cache = path.join(caches, `${repo.id}.git`);
    yield* fetchTurn(repo.id).withPermit(fetch(repo, commit, cache));
    const staging = path.join(trees, `.staging-${NodeCrypto.randomUUID()}`);
    // A private index per staging tree, so concurrent checkouts of one cache share no index file.
    const env = { ...gitEnv(undefined), GIT_INDEX_FILE: `${staging}.index` };
    // A committed symlink would carry a client's overlay write out of its check dir; it becomes a file.
    const git = ["-c", "core.symlinks=false", "--git-dir", cache, "--work-tree", staging];
    yield* fs.makeDirectory(staging).pipe(Effect.orDie);
    yield* run(staging, "git", [...git, "read-tree", commit], env);
    yield* run(staging, "git", [...git, "checkout-index", "--all"], env);
    yield* Effect.gen(function* () {
      yield* fs.remove(`${staging}.index`);
      yield* fs.makeDirectory(path.dirname(dir), { recursive: true });
      yield* fs.rename(staging, dir);
    }).pipe(Effect.orDie);
    yield* storage.record(dir);
    return dir;
  });

  const describe = Effect.fn("Checkouts.describe")(function* (dir: string) {
    const read = (file: string) =>
      fs.readFile(path.join(dir, file)).pipe(
        Effect.map((content): Uint8Array | undefined => content),
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.die(error),
        }),
      );
    const entries = yield* fs.readDirectory(dir, { recursive: true }).pipe(Effect.orDie);
    // A directory may carry the name too, such as a SvelteKit route.
    const packages = yield* Effect.filter(
      entries
        .filter((entry) => path.basename(entry) === "package.json")
        .filter((entry) => !entry.split(path.sep).includes("node_modules")),
      (entry) => fs.stat(path.join(dir, entry)).pipe(Effect.map((info) => info.type === "File")),
    ).pipe(
      Effect.map((manifests) => manifests.map((entry) => path.dirname(entry))),
      Effect.orDie,
    );
    const lockfile = sha256((yield* read("pnpm-lock.yaml")) ?? new Uint8Array());
    const manifest = yield* read("package.json");
    const pinned = Effect.try(() =>
      manifest === undefined ? undefined : JSON.parse(Buffer.from(manifest).toString()),
    ).pipe(
      Effect.map((json: unknown) =>
        Predicate.hasProperty(json, "packageManager") && typeof json.packageManager === "string"
          ? json.packageManager.replace(/@.*$/, "")
          : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );
    const chain = yield* tsconfigChain((file) =>
      read(file).pipe(
        Effect.map((content) =>
          content === undefined ? undefined : Buffer.from(content).toString(),
        ),
      ),
    );
    return {
      dir,
      packages,
      lockfile,
      tsconfigs: chain.files,
      unsafeConfig: chain.unsafe,
      packageManager: yield* pinned,
    };
  });

  const ensure: Checkouts["Service"]["ensure"] = (repo, commit) =>
    once(`${repo.id}@${commit}`, materialize(repo, commit).pipe(Effect.flatMap(describe))).pipe(
      Effect.tap((checkout) => storage.touch(checkout.dir)),
    );

  return Checkouts.of({ ensure });
});

export const layer = Layer.effect(Checkouts, make);
