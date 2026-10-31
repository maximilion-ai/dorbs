import { assert, it } from "@effect/vitest";

import { mebibytes } from "./Docker.ts";

it("reads Docker memory sizes in MiB", () => {
  assert.deepStrictEqual(
    ["8g", "512m", "1048576k", "2G", "nonsense"].map(mebibytes),
    [8192, 512, 1024, 2048, 0],
  );
});
