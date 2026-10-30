import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { ServiceConfig } from "./ServiceConfig.ts";
import * as Storage from "./Storage.ts";

const BUDGET = 15;

const TestStorage = Storage.layer.pipe(
  Layer.provide(
    Layer.succeed(ServiceConfig, {
      dataDir: "/nonexistent",
      token: Redacted.make("unused"),
      repos: new Map(),
      processTimeout: Duration.minutes(1),
      cacheMaxBytes: BUDGET,
      confine: false,
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

// A pnpm install links into its store and to its siblings, so a walk that follows links counts far
// more than the install holds, without end when the links form a cycle.
it.live("counts each file of a tree once, and no file outside it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const storage = yield* Storage.Storage;
    const outside = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFile(`${outside}/big`, new Uint8Array(1024 * 1024));
    const tree = `${yield* fs.makeTempDirectoryScoped()}/tree`;
    yield* fs.makeDirectory(tree);
    yield* fs.writeFileString(`${tree}/ten`, "0123456789");
    yield* fs.link(`${tree}/ten`, `${tree}/ten-again`);
    yield* fs.symlink(`${outside}/big`, `${tree}/big-file`);
    yield* fs.symlink(outside, `${tree}/big-dir`);
    yield* fs.symlink(tree, `${tree}/cycle`);

    yield* storage.record(tree);
    yield* storage.use(Effect.void);
    assert.isTrue(yield* fs.exists(tree), "ten bytes fit the budget");

    // Twenty bytes of real files exceed the budget, so the next check evicts the tree.
    yield* fs.writeFileString(`${tree}/more`, "0123456789");
    yield* storage.record(tree);
    yield* storage.use(Effect.void);
    assert.isFalse(yield* fs.exists(tree), "twenty bytes do not");
  }).pipe(Effect.scoped, Effect.provide(TestStorage)),
);
