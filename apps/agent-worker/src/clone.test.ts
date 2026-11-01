import { assert, it } from "@effect/vitest";

import { applyDelta, gitIndex, packIndex, type PackObject } from "./clone.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

it("applies a git delta's copies and inserts", () => {
  const base = bytes("hello world");
  // source 11, target 17; copy "hello " (offset 0, 6 bytes), insert "there ", copy "world" (offset 6, 5 bytes).
  const delta = Uint8Array.from([11, 17, 0x90, 6, 6, ...bytes("there "), 0x91, 6, 5]);
  assert.strictEqual(text(applyDelta(base, delta)), "hello there world");
});

it("refuses a delta whose base has another size", () => {
  assert.throws(() => applyDelta(bytes("short"), Uint8Array.from([11, 1, 1, 0x41])));
});

it("lays a pack index out as git's version 2: fanout, sorted ids, CRCs and offsets", () => {
  const object = (oid: string, offset: number): PackObject => ({
    oid,
    type: "blob",
    data: new Uint8Array(),
    offset,
    crc: offset + 1,
  });
  const pack = new Uint8Array(32).fill(7);
  const idx = packIndex(
    [object(`ff${"0".repeat(38)}`, 12), object(`01${"0".repeat(38)}`, 40)],
    pack,
  );
  const view = new DataView(idx.buffer);
  assert.deepStrictEqual([...idx.subarray(0, 4)], [0xff, 0x74, 0x4f, 0x63]);
  assert.strictEqual(view.getUint32(4), 2);
  assert.strictEqual(view.getUint32(8), 0);
  assert.strictEqual(view.getUint32(8 + 0x01 * 4), 1);
  assert.strictEqual(view.getUint32(8 + 0xff * 4), 2);
  const oids = 8 + 256 * 4;
  assert.strictEqual(idx[oids], 0x01);
  assert.strictEqual(idx[oids + 20], 0xff);
  assert.deepStrictEqual([view.getUint32(oids + 40), view.getUint32(oids + 44)], [41, 13]);
  assert.deepStrictEqual([view.getUint32(oids + 48), view.getUint32(oids + 52)], [40, 12]);
  assert.strictEqual(idx.length, oids + 2 * 28 + 40);
});

it("writes index entries sorted, with the stats isomorphic-git compares and the tree's modes", () => {
  const oid = "a".repeat(40);
  const index = gitIndex([
    { path: "src/b.ts", mode: "100755", oid, mtime: 1_700_000_000_123, inode: 9, size: 5 },
    { path: "README.md", mode: "100644", oid, mtime: 1_700_000_000_000, inode: 4, size: 3 },
  ]);
  const view = new DataView(index.buffer);
  assert.strictEqual(text(index.subarray(0, 4)), "DIRC");
  assert.strictEqual(view.getUint32(8), 2);
  const first = 12;
  assert.strictEqual(text(index.subarray(first + 62, first + 62 + 9)), "README.md");
  assert.strictEqual(view.getUint32(first + 8), 1_700_000_000);
  assert.strictEqual(view.getUint32(first + 20), 4);
  assert.strictEqual(view.getUint32(first + 24), 0o100644);
  const second = first + Math.ceil((62 + 9 + 1) / 8) * 8;
  assert.strictEqual(text(index.subarray(second + 62, second + 62 + 8)), "src/b.ts");
  assert.strictEqual(view.getUint32(second + 24), 0o100755);
  assert.strictEqual(view.getUint32(second + 36), 5);
});
