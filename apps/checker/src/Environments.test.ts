import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import { CommitSha, RelativePath, RepoId } from "@dorbs/protocol/typecheck";

import { makeRepo } from "../../../scripts/gitFixture.ts";
import { Docker } from "./Docker.ts";
import { type EnvSpec, Environments, layer as environmentsLayer } from "./Environments.ts";
import type { Recipe } from "./Recipe.ts";
import { ServiceConfig, type Settings } from "./ServiceConfig.ts";

const RECIPE: Recipe = {
  image: "node",
  keyFiles: [RelativePath.make("package.json")],
  setup: [{ id: "install", run: "install", cwd: ".", network: true }],
  checks: [],
  test: undefined,
  notes: [],
};

/** A Docker that runs nothing: setup writes `bytes` into the environment, exec answers "ok". */
const fakeDocker = (options: {
  readonly failing?: boolean;
  readonly bytes?: number;
  /** Holds every exec until it opens. */
  readonly gate?: Deferred.Deferred<void>;
  readonly containers?: ReadonlyArray<{ name: string; env: string; running: boolean }>;
}) => {
  const calls: Array<string> = [];
  let running = 0;
  let peak = 0;
  const docker = Docker.of({
    imageId: () => Effect.succeed("image"),
    setup: (_image, envDir, spec) =>
      Effect.sync(() => {
        calls.push(`setup ${spec.run} network=${spec.network}`);
        NodeFS.writeFileSync(
          NodePath.join(envDir, "home/install"),
          "x".repeat(options.bytes ?? 1024),
        );
        return options.failing === true
          ? {
              stdout: "",
              stderr: "npm error 404 Not Found",
              exitCode: 1,
              timedOut: false,
              truncated: false,
            }
          : { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
      }),
    create: (name) => Effect.sync(() => (calls.push(`create ${name}`), "7")),
    exec: Effect.fn("FakeDocker.exec")(function* (container, spec) {
      calls.push(`exec ${container} ${spec.run}`);
      running += 1;
      peak = Math.max(peak, running);
      if (options.gate !== undefined) yield* Deferred.await(options.gate);
      running -= 1;
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false };
    }),
    reap: () => Effect.succeed(true),
    start: (name) => Effect.sync(() => (calls.push(`start ${name}`), "7")),
    stop: (name) => Effect.sync(() => void calls.push(`stop ${name}`)),
    remove: (name) => Effect.sync(() => void calls.push(`remove ${name}`)),
    list: Effect.sync(() => options.containers ?? []),
  });
  return { docker, calls, peak: () => peak };
};

const repoFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checker-envs-"));
  const gitDir = NodePath.join(root, "repo.git");
  const commit = CommitSha.make(
    makeRepo(gitDir, { "package.json": "{}\n", "src/a.ts": "export const a = 1;\n" }),
  );
  return { root, gitDir, commit, dataDir: NodePath.join(root, "data") };
};

const settings = (dataDir: string, overrides: Partial<Settings> = {}): Settings => ({
  dataDir,
  token: Redacted.make("t"),
  repos: new Map(),
  diskBudget: 1024 ** 3,
  idleAfter: Duration.minutes(10),
  retrySetupAfter: Duration.minutes(10),
  setupTimeout: Duration.minutes(1),
  checkTimeout: Duration.minutes(1),
  testTimeout: Duration.minutes(1),
  runSlots: 4,
  containerMemory: "1g",
  setupMemory: "1g",
  containerCpus: 1,
  containerPids: 64,
  setupEgress: "open",
  egressAllow: undefined,
  ...overrides,
});

const environments = (docker: Docker["Service"], config: Settings) =>
  environmentsLayer.pipe(
    Layer.provide(Layer.succeed(Docker, docker)),
    Layer.provide(Layer.succeed(ServiceConfig, config)),
    Layer.provide(NodeServices.layer),
  );

const spec = (gitDir: string, key: string): EnvSpec => ({
  key,
  repo: RepoId.make("test/repo"),
  gitDir,
  recipe: RECIPE,
  image: "image",
  keyChange: { files: [], deleted: [] },
});

const NO_CHANGE = { files: [], deleted: [] };

it.effect("sets an environment up once for concurrent requests and runs them one at a time", () => {
  const { gitDir, commit, dataDir } = repoFixture();
  return Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const fake = fakeDocker({ gate });
    const runs = yield* Effect.gen(function* () {
      const envs = yield* Environments;
      const run = envs.use(spec(gitDir, "k1"), commit, NO_CHANGE, (session) =>
        session.exec({ cwd: ".", run: "check", timeout: "1 minute" }),
      );
      const both = yield* Effect.all([run, run], { concurrency: "unbounded" }).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      return yield* Fiber.join(both);
    }).pipe(Effect.provide(environments(fake.docker, settings(dataDir))));
    assert.deepStrictEqual(
      runs.map((run) => run._tag),
      ["Used", "Used"],
    );
    assert.strictEqual(fake.calls.filter((call) => call.startsWith("setup")).length, 1);
    assert.strictEqual(fake.peak(), 1);
  });
});

it.effect("lays the change over the tree only while the run holds the environment", () => {
  const { gitDir, commit, dataDir } = repoFixture();
  return Effect.gen(function* () {
    const fake = fakeDocker({});
    const file = NodePath.join(dataDir, "envs/k1/repo/src/a.ts");
    const seen = yield* Effect.gen(function* () {
      const envs = yield* Environments;
      return yield* envs.use(
        spec(gitDir, "k1"),
        commit,
        { files: [{ path: RelativePath.make("src/a.ts"), content: "changed" }], deleted: [] },
        () => Effect.sync(() => NodeFS.readFileSync(file, "utf8")),
      );
    }).pipe(Effect.provide(environments(fake.docker, settings(dataDir))));
    assert.strictEqual(seen._tag === "Used" && seen.value, "changed");
    assert.strictEqual(NodeFS.readFileSync(file, "utf8"), "export const a = 1;\n");
  });
});

it.effect("answers a failed setup with its output until the retry delay passes", () => {
  const { gitDir, commit, dataDir } = repoFixture();
  return Effect.gen(function* () {
    const fake = fakeDocker({ failing: true });
    yield* Effect.gen(function* () {
      const envs = yield* Environments;
      const run = envs.use(spec(gitDir, "k1"), commit, NO_CHANGE, () => Effect.void);
      const failed = {
        _tag: "SetupFailed",
        envKey: "k1",
        step: "install",
        output: "npm error 404 Not Found",
      };
      assert.deepStrictEqual<unknown>(yield* run, failed);
      assert.deepStrictEqual<unknown>(yield* run, failed);
      assert.strictEqual(fake.calls.filter((call) => call.startsWith("setup")).length, 1);
      yield* TestClock.adjust("11 minutes");
      assert.deepStrictEqual<unknown>(yield* run, failed);
      assert.strictEqual(fake.calls.filter((call) => call.startsWith("setup")).length, 2);
    }).pipe(Effect.provide(environments(fake.docker, settings(dataDir))));
    assert.isFalse(NodeFS.existsSync(NodePath.join(dataDir, "envs/k1/home")));
  });
});

it.effect("evicts the least recently used environment to keep under the disk budget", () => {
  const { gitDir, commit, dataDir } = repoFixture();
  return Effect.gen(function* () {
    const fake = fakeDocker({ bytes: 400 * 1024 });
    yield* Effect.gen(function* () {
      const envs = yield* Environments;
      const use = (key: string) =>
        envs.use(spec(gitDir, key), commit, NO_CHANGE, () => Effect.void);
      yield* use("k1");
      yield* TestClock.adjust("1 second");
      yield* use("k2");
      yield* TestClock.adjust("1 second");
      yield* use("k3");
      const states = Object.fromEntries((yield* envs.list).map((env) => [env.key, env.state]));
      assert.deepStrictEqual(states, { k1: "Evicted", k2: "Ready", k3: "Ready" });
      assert.isFalse(NodeFS.existsSync(NodePath.join(dataDir, "envs/k1")));
      yield* use("k1");
      assert.strictEqual(fake.calls.filter((call) => call.startsWith("setup")).length, 4);
    }).pipe(
      Effect.provide(environments(fake.docker, settings(dataDir, { diskBudget: 1024 * 1024 }))),
    );
    assert.include(fake.calls, "remove dorbs-env-k1");
  });
});

it.effect("stops an idle environment's container and starts it for the next run", () => {
  const { gitDir, commit, dataDir } = repoFixture();
  return Effect.gen(function* () {
    const fake = fakeDocker({});
    yield* Effect.gen(function* () {
      const envs = yield* Environments;
      const use = envs.use(spec(gitDir, "k1"), commit, NO_CHANGE, () => Effect.void);
      yield* use;
      yield* TestClock.adjust("11 minutes");
      assert.deepStrictEqual(
        (yield* envs.list).map((env) => env.state),
        ["Idle"],
      );
      yield* use;
    }).pipe(Effect.provide(environments(fake.docker, settings(dataDir))));
    assert.deepStrictEqual(
      fake.calls.filter((call) => /^(stop|start|setup)/.test(call)),
      ["setup install network=true", "stop dorbs-env-k1", "start dorbs-env-k1"],
    );
  });
});

it.effect("comes back after a restart with its environments stopped and strays removed", () => {
  const { gitDir, commit, dataDir } = repoFixture();
  return Effect.gen(function* () {
    const first = fakeDocker({});
    yield* Effect.flatMap(Environments, (envs) =>
      envs.use(spec(gitDir, "k1"), commit, NO_CHANGE, () => Effect.void),
    ).pipe(Effect.provide(environments(first.docker, settings(dataDir))));
    NodeFS.mkdirSync(NodePath.join(dataDir, "envs/half-set-up"));
    const second = fakeDocker({
      containers: [
        { name: "dorbs-env-k1", env: "k1", running: true },
        { name: "dorbs-env-gone", env: "gone", running: true },
      ],
    });
    yield* Effect.gen(function* () {
      const envs = yield* Environments;
      assert.deepStrictEqual(
        (yield* envs.list).map((env) => [env.key, env.state]),
        [["k1", "Idle"]],
      );
      const ran = yield* envs.use(spec(gitDir, "k1"), commit, NO_CHANGE, (session) =>
        session.exec({ cwd: ".", run: "check", timeout: "1 minute" }),
      );
      assert.strictEqual(ran._tag, "Used");
    }).pipe(Effect.provide(environments(second.docker, settings(dataDir))));
    assert.deepStrictEqual(second.calls, [
      "stop dorbs-env-k1",
      "remove dorbs-env-gone",
      "start dorbs-env-k1",
      "exec dorbs-env-k1 check",
    ]);
    assert.isFalse(NodeFS.existsSync(NodePath.join(dataDir, "envs/half-set-up")));
  });
});
