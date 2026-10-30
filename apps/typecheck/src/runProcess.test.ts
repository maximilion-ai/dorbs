import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { runProcess } from "./runProcess.ts";

// Resolves once every writer of the FIFO is gone, which for a process holding it means it died.
const writersGone = (fifo: string) =>
  new Promise<void>((resolve) => {
    const stream = NodeFS.createReadStream(fifo);
    stream.on("data", () => {});
    stream.on("close", () => resolve());
  });

it.live("kills the whole process group when a process outlives its deadline", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* runProcess(spawner, dir, "mkfifo", ["child.fifo"], { timeout: "10 seconds" });
    const childGone = writersGone(`${dir}/child.fifo`);
    // The shell and its child both ignore SIGTERM, so only SIGKILL ends them.
    const exit = yield* runProcess(
      spawner,
      dir,
      "sh",
      ["-c", 'trap "" TERM; sleep 60 3>child.fifo & wait'],
      { timeout: "200 millis" },
    ).pipe(Effect.exit);
    assert.include(
      Exit.isFailure(exit) ? String(exit.cause) : "succeeded",
      "sh timed out after 200ms",
    );
    // A child the kill missed would hold the FIFO open for a minute, past the test timeout.
    yield* Effect.promise(() => childGone);
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
