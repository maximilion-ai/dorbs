import * as NodeURL from "node:url";

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
const ENV_MOUNT = "/env";
export const REPO_ROOT = `${ENV_MOUNT}/repo`;

/** Every container's environment: caches under the environment's home, no secrets, no color. */
const CONTAINER_ENV: Readonly<Record<string, string>> = {
  HOME: `${ENV_MOUNT}/home`,
  TMPDIR: "/tmp",
  CI: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  COREPACK_HOME: `${ENV_MOUNT}/home/.cache/corepack`,
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  npm_config_update_notifier: "false",
  // yarn 1 caches under /usr/local/share otherwise, which the read-only root refuses, then in /tmp.
  YARN_CACHE_FOLDER: `${ENV_MOUNT}/home/.cache/yarn`,
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
    /**
     * Makes and starts an environment's container: no network, read-only but for /env and /tmp.
     * Answers the pid of its keeper process, which `reap` spares.
     */
    readonly create: (
      name: string,
      env: string,
      image: string,
      envDir: string,
    ) => Effect.Effect<string>;
    readonly exec: (container: string, spec: RunSpec) => Effect.Effect<ProcessResult>;
    /**
     * Kills every process in the container but its keeper, so nothing a run started outlives it.
     * Answers false when it had to stop the container to do so.
     */
    readonly reap: (container: string, keeper: string) => Effect.Effect<boolean>;
    /** Starts a stopped container; answers its keeper's pid, or undefined when it cannot start. */
    readonly start: (container: string) => Effect.Effect<string | undefined>;
    readonly stop: (container: string) => Effect.Effect<void>;
    readonly remove: (container: string) => Effect.Effect<void>;
    /** The containers this service made, by their label. */
    readonly list: Effect.Effect<ReadonlyArray<Container>>;
  }
>()("dorbs/checker/Docker") {}

const LABEL = "dorbs.checker.env";
const SETUP_NETWORK = "dorbs-setup";
const EGRESS = "dorbs-egress";
const EGRESS_URL = `http://${EGRESS}:3128`;
// Every proxy variable the package managers read: npm, yarn, pnpm, bun, uv, pip, cargo, go and Node's fetch.
const PROXY_ENV = [
  ...["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].map(
    (name) => `${name}=${EGRESS_URL}`,
  ),
  `npm_config_https_proxy=${EGRESS_URL}`,
  `npm_config_proxy=${EGRESS_URL}`,
  `YARN_HTTPS_PROXY=${EGRESS_URL}`,
  `YARN_HTTP_PROXY=${EGRESS_URL}`,
  "NODE_USE_ENV_PROXY=1",
  "NO_PROXY=",
];

// Kills every process but pid 1 (docker's init), the keeper whose pid is $1, and this shell, until
// none is left. Builtins only, so the shell starts no process of its own to spare.
const REAP = [
  "for round in 1 2 3 4 5; do",
  "  left=0",
  "  for d in /proc/[0-9]*; do",
  "    p=${d#/proc/}",
  '    case "$p" in 1|"$1"|$$) continue ;; esac',
  '    kill -9 "$p" 2>/dev/null && left=1',
  "  done",
  '  [ "$left" = 0 ] && exit 0',
  "done",
  "exit 1",
].join("\n");

// The keeper is the one process besides pid 1 when the container has just started.
const KEEPER =
  'for d in /proc/[0-9]*; do p=${d#/proc/}; case "$p" in 1|$$) ;; *) echo "$p" ;; esac; done';

/** A Docker memory size such as 8g or 512m, in MiB; 0 when it does not parse. */
export const mebibytes = (size: string): number => {
  const match = /^(\d+)([kmg]?)b?$/i.exec(size.trim());
  if (match === null) return 0;
  const scale =
    { "": 1 / 1024 / 1024, k: 1 / 1024, m: 1, g: 1024 }[(match[2] ?? "").toLowerCase()] ?? 0;
  return Number(match[1]) * scale;
};

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

  // Node sizes its heap below what big type checks need; give it three quarters of the container.
  const heapMiB = Math.floor((mebibytes(config.containerMemory) * 3) / 4);
  const env = Object.entries({
    ...CONTAINER_ENV,
    ...(heapMiB > 0 ? { NODE_OPTIONS: `--max-old-space-size=${heapMiB}` } : {}),
  }).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
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
          spec.network ? (config.setupEgress === "proxy" ? SETUP_NETWORK : "bridge") : "none",
          ...limits(config.setupMemory),
          ...env,
          ...(spec.network && config.setupEgress === "proxy"
            ? PROXY_ENV.flatMap((pair) => ["-e", pair])
            : []),
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
      return yield* keeper(name);
    },
  );

  const exec: Docker["Service"]["exec"] = (container, spec) =>
    docker(
      ["exec", "-w", workdir(spec.cwd), container, "sh", "-c", spec.run],
      spec.timeout,
      spec.keepBytes,
    );

  const keeper = Effect.fn("Docker.keeper")(function* (container: string) {
    const pids = (yield* ok(["exec", container, "sh", "-c", KEEPER]))
      .split("\n")
      .filter((line) => line !== "");
    if (pids.length !== 1)
      return yield* Effect.die(new Error(`${container} has no single keeper: ${pids.join(" ")}`));
    return pids[0] ?? "";
  });

  const reap: Docker["Service"]["reap"] = Effect.fn("Docker.reap")(
    function* (container, keeperPid) {
      const result = yield* docker(["exec", container, "sh", "-c", REAP, "reap", keeperPid]);
      if (result.exitCode === 0) return true;
      // Something keeps forking: stopping the container kills it all; the next run starts it again.
      yield* docker(["stop", "--time", "0", container]);
      return false;
    },
  );

  const start: Docker["Service"]["start"] = Effect.fn("Docker.start")(function* (container) {
    const result = yield* docker(["start", container]);
    return result.exitCode === 0 ? yield* keeper(container) : undefined;
  });

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

  // The setup network has no route out but the egress proxy, which is on it and on the default bridge.
  if (config.setupEgress === "proxy") {
    if ((yield* docker(["network", "inspect", SETUP_NETWORK])).exitCode !== 0) {
      yield* ok(["network", "create", "--internal", SETUP_NETWORK]);
    }
    yield* docker(["rm", "-f", EGRESS]);
    yield* ok([
      "run",
      "-d",
      "--name",
      EGRESS,
      "--restart",
      "unless-stopped",
      "--network",
      "bridge",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "256m",
      ...(config.egressAllow === undefined ? [] : ["-e", `EGRESS_ALLOW=${config.egressAllow}`]),
      "-v",
      `${NodeURL.fileURLToPath(new URL("egress.ts", import.meta.url))}:/egress.ts:ro`,
      "dorbs-checker/node:1",
      "node",
      "/egress.ts",
    ]);
    yield* ok(["network", "connect", SETUP_NETWORK, EGRESS]);
  }

  return Docker.of({ imageId, setup, create, exec, reap, start, stop, remove, list });
});

export const layer = Layer.effect(Docker, make);
