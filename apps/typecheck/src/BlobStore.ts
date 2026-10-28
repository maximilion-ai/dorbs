import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { Sha256 } from "@dorbs/protocol/typecheck";

import { ServiceConfig } from "./ServiceConfig.ts";

export class BlobHashMismatch extends Schema.TaggedError<BlobHashMismatch>()("BlobHashMismatch", {
  expected: Sha256,
  actual: Schema.String,
}) {
  override get message(): string {
    return `Blob content hashes to ${this.actual}, not ${this.expected}`;
  }
}

export class BlobStore extends Context.Service<
  BlobStore,
  {
    readonly put: (sha256: Sha256, content: Uint8Array) => Effect.Effect<void, BlobHashMismatch>;
    readonly missing: (sha256s: ReadonlyArray<Sha256>) => Effect.Effect<ReadonlyArray<Sha256>>;
    readonly pathOf: (sha256: Sha256) => string;
  }
>()("dorbs/typecheck/BlobStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join((yield* ServiceConfig).dataDir, "blobs");
  yield* fs.makeDirectory(dir, { recursive: true });

  const pathOf = (sha256: Sha256) => path.join(dir, sha256);

  const put: BlobStore["Service"]["put"] = Effect.fn("BlobStore.put")(function* (sha256, content) {
    const actual = NodeCrypto.createHash("sha256").update(content).digest("hex");
    if (actual !== sha256) return yield* new BlobHashMismatch({ expected: sha256, actual });
    // Write then rename, so a reader never sees a half-written blob under its hash.
    const staging = path.join(dir, `.${sha256}.${NodeCrypto.randomUUID()}`);
    yield* fs.writeFile(staging, content).pipe(Effect.orDie);
    return yield* fs.rename(staging, pathOf(sha256)).pipe(Effect.orDie);
  });

  const missing: BlobStore["Service"]["missing"] = Effect.fn("BlobStore.missing")(
    function* (sha256s) {
      const unique = [...new Set(sha256s)];
      const present = yield* Effect.forEach(unique, (sha256) => fs.exists(pathOf(sha256)), {
        concurrency: "unbounded",
      }).pipe(Effect.orDie);
      return unique.filter((_, index) => !present[index]);
    },
  );

  return BlobStore.of({ put, missing, pathOf });
});

export const layer = Layer.effect(BlobStore, make);
