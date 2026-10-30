import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// Tools read client-chosen files, so they get no secrets. Runner variables also change them:
// oxlint ignores .oxlintrc.json when VP_VERSION is set.
const TOOL_ENV = {
  PATH: process.env["PATH"],
  HOME: process.env["HOME"],
  TMPDIR: process.env["TMPDIR"],
};

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** A process that ran past its deadline or wrote more than the service reads; it is killed. */
export class ProcessFailed extends Schema.TaggedError<ProcessFailed>()("ProcessFailed", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export type RunOptions = {
  readonly env?: Record<string, string>;
  /** How long the process may run. Past it, its whole process group gets SIGTERM, then SIGKILL. */
  readonly timeout: Duration.Input;
};

const capture = (
  command: string,
  name: string,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
) =>
  Effect.suspend(() => {
    const chunks: Array<Uint8Array> = [];
    let bytes = 0;
    return Stream.runForEach(stream, (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        return new ProcessFailed({ reason: `${command} wrote more than 16 MiB to ${name}` });
      }
      chunks.push(chunk);
      return Effect.void;
    }).pipe(Effect.map(() => Buffer.concat(chunks).toString()));
  });

export const runProcess = Effect.fn("runProcess")(
  function* (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    cwd: string,
    command: string,
    args: ReadonlyArray<string>,
    options: RunOptions,
  ) {
    // Leaving the scope kills the process group: on success, failure, timeout or interruption.
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd,
        env: { ...TOOL_ENV, ...options.env },
        extendEnv: false,
        forceKillAfter: "1 second",
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        capture(command, "stdout", handle.stdout),
        capture(command, "stderr", handle.stderr),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode };
  },
  (effect, _spawner, _cwd, command, _args, options) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: options.timeout,
        orElse: () =>
          Effect.fail(
            new ProcessFailed({
              reason: `${command} timed out after ${Duration.format(Duration.fromInputUnsafe(options.timeout))}`,
            }),
          ),
      }),
      Effect.scoped,
    ),
);
