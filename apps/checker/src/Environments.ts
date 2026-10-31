import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { Change, SetupFailed } from "@dorbs/protocol/checker";
import { CommitSha, RepoId } from "@dorbs/protocol/typecheck";

import { Docker, type RunSpec } from "./Docker.ts";
import { type EnvEvent, type EnvState, transition } from "./Environment.ts";
import type { Recipe } from "./Recipe.ts";
import { type ProcessResult, runProcess } from "./runProcess.ts";
import { ServiceConfig } from "./ServiceConfig.ts";
import * as Trees from "./Tree.ts";

/** What makes an environment: its key, and what setting it up needs. */
export type EnvSpec = {
  readonly key: string;
  readonly repo: RepoId;
  /** The repo's bare cache, which holds the commit. */
  readonly gitDir: string;
  readonly recipe: Recipe;
  /** The image id. */
  readonly image: string;
  /** The change's key files, laid over the commit while setup runs, as the key includes them. */
  readonly keyChange: Change;
};

/** What a run gets while it holds an environment. */
export type Session = {
  readonly exec: (spec: RunSpec) => Effect.Effect<ProcessResult>;
};

export type Used<A> = {
  readonly _tag: "Used";
  readonly value: A;
  readonly setupMs: number;
  readonly overlayMs: number;
};

export type EnvSummary = {
  readonly key: string;
  readonly repo: RepoId;
  readonly state: EnvState["_tag"];
  readonly bytes: number;
};

export class Environments extends Context.Service<
  Environments,
  {
    /**
     * Runs `work` in the spec's environment at `commit` with `change` laid over its tree, after any
     * run before it on that environment: sets the environment up first if needed, and takes the
     * change off afterwards.
     */
    readonly use: <A, E>(
      spec: EnvSpec,
      commit: CommitSha,
      change: Change,
      work: (session: Session) => Effect.Effect<A, E>,
    ) => Effect.Effect<Used<A> | SetupFailed, E | Trees.UnsafePath>;
    readonly list: Effect.Effect<ReadonlyArray<EnvSummary>>;
  }
>()("dorbs/checker/Environments") {}

type Env = {
  readonly key: string;
  readonly repo: RepoId;
  readonly dir: string;
  readonly container: string;
  readonly queue: Semaphore.Semaphore;
  state: EnvState;
  /** Settles when the setup in flight does, so concurrent requests wait for one setup. */
  settingUp: Deferred.Deferred<void> | undefined;
  bytes: number;
  measuredAt: number;
};

const Meta = Schema.fromJsonString(
  Schema.Struct({
    key: Schema.String,
    repo: RepoId,
    tree: CommitSha,
    lastUsed: Schema.Number,
    bytes: Schema.Number,
  }),
);
const decodeMeta = Schema.decodeUnknownOption(Meta);
const encodeMeta = Schema.encodeSync(Meta);

/** A failed step's output, its end kept, which is where the error is. */
const tail = (result: ProcessResult) =>
  `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-60).join("\n").slice(-8000);

const containerName = (key: string) => `dorbs-env-${key.slice(0, 16)}`;

const make = Effect.gen(function* () {
  const docker = yield* Docker;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServiceConfig;
  const trees = Trees.make(spawner);
  const envsDir = NodePath.join(config.dataDir, "envs");
  const metaDir = NodePath.join(config.dataDir, "meta");
  const trashDir = NodePath.join(config.dataDir, "trash");
  for (const dir of [envsDir, metaDir, trashDir]) {
    yield* Effect.promise(() => NodeFSP.mkdir(dir, { recursive: true }));
  }
  const envs = new Map<string, Env>();
  const slots = yield* Semaphore.make(config.runSlots);
  const setups = yield* Semaphore.make(2);
  const evictTurn = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;

  const now = Clock.currentTimeMillis;
  const metaFile = (key: string) => NodePath.join(metaDir, `${key}.json`);
  const treeOf = (env: Env, gitDir: string): Trees.Tree => ({
    gitDir,
    workTree: NodePath.join(env.dir, "repo"),
    indexFile: NodePath.join(metaDir, `${env.key}.index`),
  });

  const move = (env: Env, event: EnvEvent) =>
    Effect.sync(() => {
      env.state = transition(env.state, event);
    });

  const saveMeta = (env: Env) =>
    Effect.promise(() => {
      const state = env.state;
      if (state._tag !== "Ready" && state._tag !== "Idle") return Promise.resolve();
      return NodeFSP.writeFile(
        metaFile(env.key),
        encodeMeta({
          key: env.key,
          repo: env.repo,
          tree: state.tree,
          lastUsed: state.lastUsed,
          bytes: env.bytes,
        }),
      );
    });

  /** Moves a directory out of the way at once and deletes it in the background. */
  const discard = Effect.fn("Environments.discard")(function* (dir: string) {
    const trash = NodePath.join(trashDir, `${NodePath.basename(dir)}-${crypto.randomUUID()}`);
    const moved = yield* Effect.promise(() =>
      NodeFSP.rename(dir, trash).then(
        () => true,
        () => false,
      ),
    );
    if (moved) {
      yield* Effect.promise(() => NodeFSP.rm(trash, { recursive: true, force: true })).pipe(
        Effect.forkIn(scope),
      );
    }
  });

  const measure = Effect.fn("Environments.measure")(function* (env: Env) {
    const result = yield* runProcess(spawner, config.dataDir, "du", ["-sk", env.dir], {
      timeout: "5 minutes",
    }).pipe(Effect.orDie);
    const kib = Number(result.stdout.split(/\s/)[0]);
    if (Number.isFinite(kib)) env.bytes = kib * 1024;
    env.measuredAt = yield* now;
    yield* saveMeta(env);
  });

  const evict = Effect.fn("Environments.evict")(function* (env: Env) {
    yield* env.queue.withPermit(
      Effect.gen(function* () {
        const state = env.state;
        if (state._tag !== "Ready" && state._tag !== "Idle" && state._tag !== "Failed") return;
        yield* docker.remove(env.container);
        yield* Effect.promise(() => NodeFSP.rm(metaFile(env.key), { force: true }));
        yield* Effect.promise(() =>
          NodeFSP.rm(`${metaFile(env.key).slice(0, -5)}.index`, { force: true }),
        );
        yield* discard(env.dir);
        env.bytes = 0;
        yield* move(env, { _tag: "Evicted" });
        yield* Effect.logInfo(`evicted environment ${env.key} of ${env.repo}`);
      }),
    );
  });

  /** Evicts the least recently used environments, other than `keep`, until the rest fit in `limit`. */
  const fit = Effect.fn("Environments.fit")(function* (limit: number, keep: string) {
    yield* evictTurn.withPermit(
      Effect.gen(function* () {
        const used = (env: Env) => {
          const state = env.state;
          return state._tag === "Ready" || state._tag === "Idle" ? state.lastUsed : 0;
        };
        const candidates = [...envs.values()]
          .filter((env) => env.key !== keep && ["Ready", "Idle", "Failed"].includes(env.state._tag))
          .toSorted((a, b) => used(a) - used(b));
        let total = [...envs.values()].reduce((sum, env) => sum + env.bytes, 0);
        for (const env of candidates) {
          if (total <= limit) break;
          total -= env.bytes;
          yield* evict(env);
        }
      }),
    );
  });

  /** Runs a setup that `ready` started: the environment is in SettingUp, with `done` to settle. */
  const setup = Effect.fn("Environments.setup")(function* (
    env: Env,
    spec: EnvSpec,
    commit: CommitSha,
    done: Deferred.Deferred<void>,
  ) {
    const started = yield* now;
    yield* Effect.logInfo(`setting up ${env.key} for ${spec.repo} at ${commit}`);
    // Room for the new environment, which may be as big as a quarter of the budget.
    yield* fit(config.diskBudget * 0.75, env.key);
    const failure = yield* setups
      .withPermit(
        Effect.gen(function* () {
          yield* discard(env.dir);
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.join(env.dir, "home"), { recursive: true }),
          );
          const tree = treeOf(env, spec.gitDir);
          yield* Effect.promise(() => NodeFSP.rm(tree.indexFile, { force: true }));
          yield* trees.materialize(tree, commit);
          const overlay = yield* trees.overlay(tree, spec.keyChange).pipe(Effect.orDie);
          for (const step of spec.recipe.setup) {
            const result = yield* docker.setup(spec.image, env.dir, {
              ...step,
              timeout: config.setupTimeout,
            });
            if (result.exitCode !== 0) {
              yield* trees.restore(tree, overlay);
              const reason = result.timedOut
                ? `timed out after ${Duration.format(config.setupTimeout)}\n`
                : "";
              return { step: step.id, output: `${reason}${tail(result)}` };
            }
          }
          yield* trees.restore(tree, overlay);
          yield* docker.create(env.container, env.key, spec.image, env.dir);
          return undefined;
        }),
      )
      .pipe(
        // A defect, such as a failed git checkout, fails the setup like a failed step, so no waiter hangs.
        Effect.catchCause((cause) =>
          Effect.succeed({ step: "service", output: Cause.pretty(cause) }),
        ),
      );
    if (failure !== undefined) {
      yield* move(env, { _tag: "SetupFailed", ...failure, at: yield* now });
      yield* discard(env.dir);
      yield* Effect.logWarning(`setup of ${env.key} failed at ${failure.step}`);
    } else {
      yield* move(env, { _tag: "SetupSucceeded", tree: commit, at: yield* now });
      yield* measure(env);
      yield* Effect.logInfo(
        `set up ${env.key} in ${(yield* now) - started} ms, ${env.bytes} bytes`,
      );
      yield* fit(config.diskBudget, env.key).pipe(Effect.forkIn(scope));
    }
    env.settingUp = undefined;
    yield* Deferred.succeed(done, undefined);
  });

  const envFor = (spec: EnvSpec): Env => {
    const existing = envs.get(spec.key);
    if (existing !== undefined) return existing;
    const env: Env = {
      key: spec.key,
      repo: spec.repo,
      dir: NodePath.join(envsDir, spec.key),
      container: containerName(spec.key),
      queue: Semaphore.makeUnsafe(1),
      state: { _tag: "Absent" },
      settingUp: undefined,
      bytes: 0,
      measuredAt: 0,
    };
    envs.set(spec.key, env);
    return env;
  };

  /** Brings the environment to Ready, Busy or Idle, or answers why it cannot be. */
  const ready = Effect.fn("Environments.ready")(function* (
    env: Env,
    spec: EnvSpec,
    commit: CommitSha,
  ): Effect.fn.Return<SetupFailed | number> {
    const started = yield* now;
    for (;;) {
      const state = env.state;
      if (state._tag === "Ready" || state._tag === "Busy" || state._tag === "Idle") {
        return (yield* now) - started;
      }
      if (state._tag === "SettingUp" && env.settingUp !== undefined) {
        yield* Deferred.await(env.settingUp);
        continue;
      }
      if (state._tag === "Failed") {
        const retryAt = state.at + Duration.toMillis(config.retrySetupAfter);
        if ((yield* now) < retryAt || env.settingUp !== undefined) {
          return {
            _tag: "SetupFailed",
            envKey: env.key,
            step: state.step,
            output: state.output,
          } as const;
        }
      }
      // One step, so no other request can start a second setup in between.
      const done = yield* Effect.sync(() => {
        env.state = transition(env.state, { _tag: "SetupStarted" });
        const deferred = Deferred.makeUnsafe<void>();
        env.settingUp = deferred;
        return deferred;
      });
      // Setup runs in the service's scope, so a client hanging up does not leave it half done.
      yield* setup(env, spec, commit, done).pipe(Effect.forkIn(scope));
      yield* Deferred.await(done);
      const after = env.state;
      if (after._tag === "Failed") {
        return {
          _tag: "SetupFailed",
          envKey: env.key,
          step: after.step,
          output: after.output,
        } as const;
      }
    }
  });

  const use: Environments["Service"]["use"] = Effect.fn("Environments.use")(function* <A, E>(
    spec: EnvSpec,
    commit: CommitSha,
    change: Change,
    work: (session: Session) => Effect.Effect<A, E>,
  ) {
    const env = envFor(spec);
    for (;;) {
      const setupMs = yield* ready(env, spec, commit);
      if (typeof setupMs !== "number") return setupMs;
      const ran = yield* env.queue.withPermit(
        Effect.gen(function* () {
          // Eviction may have taken it while this request waited in the queue.
          const state = env.state;
          if (state._tag !== "Ready" && state._tag !== "Idle") return undefined;
          if (state._tag === "Idle") {
            if (!(yield* docker.start(env.container))) {
              yield* docker.create(env.container, env.key, spec.image, env.dir);
            }
            yield* move(env, { _tag: "Started" });
          }
          yield* move(env, { _tag: "Acquired" });
          const tree = treeOf(env, spec.gitDir);
          return yield* slots
            .withPermit(
              Effect.gen(function* () {
                yield* trees.recover(tree);
                const moveStarted = yield* now;
                yield* trees.moveTo(tree, state.tree, commit);
                const laidAt = yield* now;
                const overlay = yield* trees.overlay(tree, change);
                const laidMs = (yield* now) - laidAt;
                // Nothing a run started may still write to the tree while the change comes off.
                const value = yield* work({
                  exec: (run) => docker.exec(env.container, run),
                }).pipe(Effect.ensuring(docker.reap(env.container)));
                const restoreAt = yield* now;
                yield* trees.restore(tree, overlay);
                const restoredMs = (yield* now) - restoreAt;
                const movedMs = laidAt - moveStarted;
                return { value, overlayMs: movedMs + laidMs + restoredMs };
              }),
            )
            .pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* trees.recover(tree);
                  yield* move(env, { _tag: "Released", tree: commit, at: yield* now });
                  yield* saveMeta(env);
                }),
              ),
            );
        }),
      );
      if (ran === undefined) continue;
      if ((yield* now) - env.measuredAt > 120_000) yield* measure(env).pipe(Effect.forkIn(scope));
      return { _tag: "Used", value: ran.value, setupMs, overlayMs: ran.overlayMs } as const;
    }
  });

  const list: Environments["Service"]["list"] = Effect.sync(() =>
    [...envs.values()].map((env) => ({
      key: env.key,
      repo: env.repo,
      state: env.state._tag,
      bytes: env.bytes,
    })),
  );

  // Environments a previous run left come back stopped; containers and directories without one go.
  const metas = yield* Effect.promise(() => NodeFSP.readdir(metaDir));
  for (const file of metas.filter((name) => name.endsWith(".json"))) {
    const text = yield* Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(metaDir, file), "utf8"),
    );
    const meta = decodeMeta(text);
    if (meta._tag === "None") continue;
    const { key, repo, tree, lastUsed, bytes } = meta.value;
    const env: Env = {
      key,
      repo,
      dir: NodePath.join(envsDir, key),
      container: containerName(key),
      queue: Semaphore.makeUnsafe(1),
      state: { _tag: "Idle", tree, lastUsed },
      settingUp: undefined,
      bytes,
      measuredAt: 0,
    };
    envs.set(key, env);
  }
  for (const container of yield* docker.list) {
    const env = envs.get(container.env);
    if (env === undefined || env.container !== container.name) yield* docker.remove(container.name);
    else if (container.running) yield* docker.stop(container.name);
  }
  for (const name of yield* Effect.promise(() => NodeFSP.readdir(envsDir))) {
    if (!envs.has(name)) yield* discard(NodePath.join(envsDir, name));
  }
  for (const name of yield* Effect.promise(() => NodeFSP.readdir(trashDir))) {
    yield* Effect.promise(() =>
      NodeFSP.rm(NodePath.join(trashDir, name), { recursive: true, force: true }),
    ).pipe(Effect.forkIn(scope));
  }

  // Stops the containers of environments idle past IDLE_AFTER; their trees and installs stay.
  const stopIdle = Effect.gen(function* () {
    const cutoff = (yield* now) - Duration.toMillis(config.idleAfter);
    for (const env of envs.values()) {
      const state = env.state;
      if (state._tag !== "Ready" || state.lastUsed > cutoff) continue;
      yield* env.queue.withPermit(
        Effect.gen(function* () {
          if (env.state._tag !== "Ready") return;
          yield* docker.stop(env.container);
          yield* move(env, { _tag: "Stopped" });
          yield* saveMeta(env);
        }),
      );
    }
  });
  yield* stopIdle.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkIn(scope));

  return Environments.of({ use, list });
});

export const layer = Layer.effect(Environments, make);
