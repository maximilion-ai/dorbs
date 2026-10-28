import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

// Tools read client-chosen files, so they get no secrets. Runner variables also change them:
// oxlint ignores .oxlintrc.json when VP_VERSION is set.
const TOOL_ENV = {
  PATH: process.env["PATH"],
  HOME: process.env["HOME"],
  TMPDIR: process.env["TMPDIR"],
};

export const runProcess = Effect.fn("runProcess")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) {
  const handle = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd, env: { ...TOOL_ENV, ...env }, extendEnv: false }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
}, Effect.scoped);
