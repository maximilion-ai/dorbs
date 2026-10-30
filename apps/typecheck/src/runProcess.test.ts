import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { runProcess } from "./runProcess.ts";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.live("kills the whole process group when a process outlives its deadline", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const dir = yield* fs.makeTempDirectoryScoped();
    // The shell and its child both ignore SIGTERM, so only SIGKILL ends them.
    const exit = yield* runProcess(
      spawner,
      dir,
      "sh",
      ["-c", 'trap "" TERM; sleep 60 & echo $! > child.pid; wait'],
      { timeout: "200 millis" },
    ).pipe(Effect.exit);
    const child = Number((yield* fs.readFileString(`${dir}/child.pid`)).trim());
    assert.include(
      Exit.isFailure(exit) ? String(exit.cause) : "succeeded",
      "sh timed out after 200ms",
    );
    assert.isFalse(isAlive(child), "the child the shell started is gone too");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("stops reading and fails when a process writes more output than it may", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exit = yield* runProcess(spawner, "/", "head", ["-c", "20000000", "/dev/zero"], {
      timeout: "1 minute",
    }).pipe(Effect.exit);
    assert.include(
      Exit.isFailure(exit) ? String(exit.cause) : "succeeded",
      "head wrote more than 16 MiB to stdout",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
