import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

// No secret of the service's own reaches git or docker unless a caller passes it.
const BASE_ENV = {
  PATH: process.env["PATH"],
  HOME: process.env["HOME"],
  TMPDIR: process.env["TMPDIR"],
  XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"],
  DOCKER_HOST: process.env["DOCKER_HOST"],
};

export type RunOptions = {
  readonly env?: Record<string, string>;
  /** How long the process may run. Past it, its process group is killed and the result says so. */
  readonly timeout: Duration.Input;
  /** Bytes of each stream kept from its start, and as many from its end; the middle is cut. */
  readonly keepBytes?: number;
};

export type ProcessResult = {
  readonly stdout: string;
  readonly stderr: string;
  /** null when the process was killed at its deadline. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Whether either stream lost its middle to the cap. */
  readonly truncated: boolean;
};

const DEFAULT_KEEP = 4 * 1024 * 1024;

/** Keeps a stream's first and last `keep` bytes. */
const keeper = (keep: number) => {
  const head: Array<Uint8Array> = [];
  let headBytes = 0;
  let tail: Array<Uint8Array> = [];
  let tailBytes = 0;
  let cut = 0;
  return {
    push: (chunk: Uint8Array) => {
      if (headBytes < keep) {
        const taken = chunk.subarray(0, keep - headBytes);
        head.push(taken);
        headBytes += taken.length;
        chunk = chunk.subarray(taken.length);
      }
      if (chunk.length === 0) return;
      tail.push(chunk);
      tailBytes += chunk.length;
      while (tailBytes - (tail[0]?.length ?? 0) >= keep) {
        cut += tail[0]?.length ?? 0;
        tailBytes -= tail[0]?.length ?? 0;
        tail = tail.slice(1);
      }
    },
    text: () =>
      cut === 0
        ? Buffer.concat([...head, ...tail]).toString()
        : `${Buffer.concat(head).toString()}\n[… ${cut} bytes cut …]\n${Buffer.concat(tail).toString()}`,
    truncated: () => cut > 0,
  };
};

const drain = (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  into: ReturnType<typeof keeper>,
) => Stream.runForEach(stream, (chunk) => Effect.sync(() => into.push(chunk)));

/** Runs a command to its end or its deadline and keeps what it printed, both cut to size. */
export const runProcess = Effect.fn("runProcess")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  options: RunOptions,
) {
  const keep = options.keepBytes ?? DEFAULT_KEEP;
  const stdout = keeper(keep);
  const stderr = keeper(keep);
  const exitCode = yield* Effect.scoped(
    Effect.gen(function* () {
      // Leaving the scope kills the process group: on exit, deadline or interruption.
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          cwd,
          env: Object.fromEntries(
            Object.entries({ ...BASE_ENV, ...options.env }).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          extendEnv: false,
          forceKillAfter: "2 seconds",
        }),
      );
      const [, , code] = yield* Effect.all(
        [drain(handle.stdout, stdout), drain(handle.stderr, stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return code;
    }).pipe(Effect.timeoutOption(Duration.fromInputUnsafe(options.timeout))),
  );
  return {
    stdout: stdout.text(),
    stderr: stderr.text(),
    exitCode: Option.getOrNull(exitCode),
    timedOut: Option.isNone(exitCode),
    truncated: stdout.truncated() || stderr.truncated(),
  } satisfies ProcessResult;
});
