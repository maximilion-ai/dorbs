import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { type Action, ActionResult, Sha256 } from "@dorbs/protocol/typecheck";

import { ServiceConfig } from "./ServiceConfig.ts";

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** SHA-256 of the action in one canonical form: fixed field order, files and deletions sorted. */
export const actionDigest = (action: Action): Sha256 => {
  const canonical = JSON.stringify([
    action.kind,
    action.toolchain,
    action.repo,
    action.commit,
    action.files
      .map((file) => [file.path, file.sha256])
      .toSorted(([a = ""], [b = ""]) => byPath(a, b)),
    action.deleted.toSorted(byPath),
  ]);
  return Sha256.make(NodeCrypto.createHash("sha256").update(canonical).digest("hex"));
};

/** Every result the service computed, by action digest, so an identical action never runs twice. */
export class ActionCache extends Context.Service<
  ActionCache,
  {
    readonly get: (digest: Sha256) => Effect.Effect<ActionResult | undefined>;
    readonly put: (digest: Sha256, result: ActionResult) => Effect.Effect<void>;
  }
>()("dorbs/typecheck/ActionCache") {}

const ResultJson = Schema.fromJsonString(ActionResult);
const decodeResult = Schema.decodeEffect(ResultJson);
const encodeResult = Schema.encodeEffect(ResultJson);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join((yield* ServiceConfig).dataDir, "actions");
  yield* fs.makeDirectory(dir, { recursive: true });

  const get: ActionCache["Service"]["get"] = Effect.fn("ActionCache.get")(function* (digest) {
    const file = path.join(dir, `${digest}.json`);
    if (!(yield* fs.exists(file))) return undefined;
    return yield* decodeResult(yield* fs.readFileString(file));
  }, Effect.orDie);

  const put: ActionCache["Service"]["put"] = Effect.fn("ActionCache.put")(function* (
    digest,
    result,
  ) {
    // Write then rename, so a reader never sees a half-written result.
    const staging = path.join(dir, `.${digest}.${NodeCrypto.randomUUID()}`);
    yield* fs.writeFileString(staging, yield* encodeResult(result));
    yield* fs.rename(staging, path.join(dir, `${digest}.json`));
  }, Effect.orDie);

  return ActionCache.of({ get, put });
});

export const layer = Layer.effect(ActionCache, make);
