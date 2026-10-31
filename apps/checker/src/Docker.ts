import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import type { Ecosystem } from "./Recipe.ts";
import { type ProcessResult, runProcess } from "./runProcess.ts";
import { ServiceConfig } from "./ServiceConfig.ts";

/** Where an environment's directory appears inside its containers; the repo is at /env/repo. */
export const ENV_MOUNT = "/env";
export const REPO_ROOT = `${ENV_MOUNT}/repo`;

/** Every container's environment: caches under the environment's home, no secrets, no color. */
export const CONTAINER_ENV: Readonly<Record<string, string>> = {
  HOME: `${ENV_MOUNT}/home`,
  TMPDIR: "/tmp",
  CI: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  COREPACK_HOME: `${ENV_MOUNT}/home/.cache/corepack`,
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  npm_config_update_notifier: "false",
  CARGO_HOME: `${ENV_MOUNT}/home/.cargo`,
  CARGO_TERM_COLOR: "never",
  GOPATH: `${ENV_MOUNT}/home/go`,
  GOCACHE: `${ENV_MOUNT}/home/.cache/go-build`,
  GOTOOLCHAIN: "auto",
  UV_PYTHON_INSTALL_DIR: `${ENV_MOUNT}/home/.local/share/uv/python`,
  PYTHONDONTWRITEBYTECODE: "1",
};

export class ImageMissing extends Schema.TaggedError<ImageMissing>()("ImageMissing", {
  image: Schema.String,
}) {
  override get message(): string {
    return `The image ${this.image} is not built; run apps/checker/images/build.sh on the checker host.`;
  }
}

export type RunSpec = {
  /** The working directory under the repo root, "." for the root. */
  readonly cwd: string;
  /** A shell command, run with sh -c. */
  readonly run: string;
  readonly timeout: Duration.Input;
  readonly keepBytes?: number;
};

export type Container = {
  readonly name: string;
  /** The environment key the container carries as a label. */
  readonly env: string;
  readonly running: boolean;
};

export class Docker extends Context.Service<
  Docker,
  {
    /** The id of the ecosystem's image, which environment keys include so a rebuild starts afresh. */
    readonly imageId: (image: Ecosystem) => Effect.Effect<string, ImageMissing>;
    /** Runs one setup step in a container of its own, with the network only when the step asks for it. */
    readonly setup: (
      image: string,
      envDir: string,
      spec: RunSpec & { readonly network: boolean },
    ) => Effect.Effect<ProcessResult>;
    /** Makes and starts an environment's container: no network, read-only but for /env and /tmp. */
    readonly create: (
      name: string,
      env: string,
      image: string,
      envDir: string,
    ) => Effect.Effect<void>;
    readonly exec: (container: string, spec: RunSpec) => Effect.Effect<ProcessResult>;
    /** Kills every process in the container that a run left behind. */
    readonly reap: (container: string) => Effect.Effect<void>;
    readonly start: (container: string) => Effect.Effect<boolean>;
    readonly stop: (container: string) => Effect.Effect<void>;
    readonly remove: (container: string) => Effect.Effect<void>;
    /** The containers this service made, by their label. */
    readonly list: Effect.Effect<ReadonlyArray<Container>>;
  }
>()("dorbs/checker/Docker") {}

const LABEL = "dorbs.checker.env";

// Kills all but pid 1 (docker's init) and its sleep, whose parent is pid 1, and this shell itself.
const REAP = [
  "for d in /proc/[0-9]*; do",
  "  p=${d#/proc/}",
  '  [ "$p" = 1 ] || [ "$p" = $$ ] && continue',
  '  ppid=$(cut -d" " -f4 "$d/stat" 2>/dev/null) || continue',
  '  [ "$ppid" = 1 ] && [ "$(cat "$d/comm" 2>/dev/null)" = sleep ] && continue',
  '  kill -9 "$p" 2>/dev/null',
  "done",
  "true",
].join("\n");

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServiceConfig;

  const docker = (
    args: ReadonlyArray<string>,
    timeout: Duration.Input = "2 minutes",
    keepBytes?: number,
  ) =>
    runProcess(spawner, config.dataDir, "docker", args, {
      timeout,
      ...(keepBytes === undefined ? {} : { keepBytes }),
    }).pipe(Effect.orDie);

  const ok = Effect.fn("Docker.ok")(function* (args: ReadonlyArray<string>) {
    const result = yield* docker(args);
    if (result.exitCode !== 0) {
      return yield* Effect.die(
        new Error(`docker ${args[0]} exited ${result.exitCode}: ${result.stderr}`),
      );
    }
    return result.stdout;
  });

  const env = Object.entries(CONTAINER_ENV).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  const limits = (memory: string) => [
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,size=1g",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--pids-limit",
    String(config.containerPids),
    "--cpus",
    String(config.containerCpus),
  ];
  const workdir = (cwd: string) => (cwd === "." ? REPO_ROOT : `${REPO_ROOT}/${cwd}`);

  const imageId = Effect.fn("Docker.imageId")(function* (image: Ecosystem) {
    const tag = `dorbs-checker/${image}:1`;
    const result = yield* docker(["image", "inspect", "--format", "{{.Id}}", tag]);
    if (result.exitCode !== 0) return yield* new ImageMissing({ image: tag });
    return result.stdout.trim();
  });

  const setup: Docker["Service"]["setup"] = Effect.fn("Docker.setup")(
    function* (image, envDir, spec) {
      const name = `dorbs-setup-${crypto.randomUUID()}`;
      const result = yield* docker(
        [
          "run",
          "--rm",
          "--name",
          name,
          "--init",
          "--network",
          spec.network ? config.setupNetwork : "none",
          ...limits(config.setupMemory),
          ...env,
          ...(spec.network ? config.setupProxyEnv.flatMap((pair) => ["-e", pair]) : []),
          "-v",
          `${envDir}:${ENV_MOUNT}`,
          "-w",
          workdir(spec.cwd),
          image,
          "sh",
          "-c",
          spec.run,
        ],
        spec.timeout,
        spec.keepBytes,
      );
      // Killing the client at the deadline leaves the container running.
      if (result.timedOut) yield* docker(["rm", "-f", name]);
      return result;
    },
  );

  const create: Docker["Service"]["create"] = Effect.fn("Docker.create")(
    function* (name, envKey, image, envDir) {
      yield* docker(["rm", "-f", name]);
      yield* ok([
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `${LABEL}=${envKey}`,
        "--init",
        "--network",
        "none",
        ...limits(config.containerMemory),
        ...env,
        "-v",
        `${envDir}:${ENV_MOUNT}`,
        "-w",
        REPO_ROOT,
        image,
        "sleep",
        "infinity",
      ]);
    },
  );

  const exec: Docker["Service"]["exec"] = (container, spec) =>
    docker(
      ["exec", "-w", workdir(spec.cwd), container, "sh", "-c", spec.run],
      spec.timeout,
      spec.keepBytes,
    );

  const reap: Docker["Service"]["reap"] = (container) =>
    docker(["exec", container, "sh", "-c", REAP]).pipe(Effect.asVoid);

  const start: Docker["Service"]["start"] = (container) =>
    docker(["start", container]).pipe(Effect.map((result) => result.exitCode === 0));

  const stop: Docker["Service"]["stop"] = (container) =>
    docker(["stop", "--time", "2", container]).pipe(Effect.asVoid);

  const remove: Docker["Service"]["remove"] = (container) =>
    docker(["rm", "-f", container]).pipe(Effect.asVoid);

  const list: Docker["Service"]["list"] = ok([
    "ps",
    "-a",
    "--filter",
    `label=${LABEL}`,
    "--format",
    `{{.Names}}\t{{.Label "${LABEL}"}}\t{{.State}}`,
  ]).pipe(
    Effect.map((stdout) =>
      stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          const [name = "", envKey = "", state = ""] = line.split("\t");
          return { name, env: envKey, running: state === "running" };
        }),
    ),
  );

  return Docker.of({ imageId, setup, create, exec, reap, start, stop, remove, list });
});

export const layer = Layer.effect(Docker, make);
