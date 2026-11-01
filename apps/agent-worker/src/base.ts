import {
  type Entry,
  fetchPack,
  gitIndex,
  listFiles,
  type Origin,
  packIndex,
  readPack,
} from "./clone.ts";
import * as Schema from "effect/Schema";

import { isGitPath } from "./git.ts";

/**
 * A repo at one commit, stored once in R2 and shared by the sessions that clone it, so no session's SQLite holds
 * the repo. Under `base/<repo>/<commit>/`: `files.json.gz` (entries by path), `content-<n>` (blob bytes in path
 * order), the commit's trees as `<pack>.pack` and `.idx`, and `manifest.json`, written last. Deterministic, so two
 * builders write the same bytes.
 */

const PART_BYTES = 16 * 1024 * 1024;
const BLOBS_PER_FETCH = 200;
// Grep reads the content in ranges of about this size rather than file by file.
const SCAN_BYTES = 8 * 1024 * 1024;

const ModeSchema = Schema.Literals(["100644", "100755", "120000", "160000"]);
export type Mode = typeof ModeSchema.Type;
const isMode = Schema.is(ModeSchema);

/** A tree entry: a file, an executable, a symbolic link (its target is its content) or a gitlink (no content). */
const FileEntrySchema = Schema.Struct({
  path: Schema.String,
  mode: ModeSchema,
  oid: Schema.String,
  size: Schema.Number,
  part: Schema.optionalKey(Schema.Number),
  offset: Schema.optionalKey(Schema.Number),
});
export type FileEntry = typeof FileEntrySchema.Type;

const ManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  commit: Schema.String,
  /** The commit time in milliseconds; every base file's mtime and ctime. */
  time: Schema.Number,
  shallow: Schema.Array(Schema.String),
  parts: Schema.Array(Schema.Number),
  /** The trees pack's name, as `pack-<sha>`. */
  pack: Schema.String,
});
export type Manifest = typeof ManifestSchema.Type;

const decodeEntries = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(FileEntrySchema)),
);
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(ManifestSchema));

export const basePrefix = (repo: string, commit: string): string => `base/${repo}/${commit}`;

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );

const gunzip = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(stream.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),
  );

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The commit time a commit object records, in milliseconds. */
const commitTime = (data: Uint8Array): number => {
  const seconds = /^committer .* (\d+) [+-]\d{4}$/mu.exec(new TextDecoder().decode(data))?.[1];
  return seconds === undefined ? 0 : Number(seconds) * 1000;
};

/**
 * Fetches `commit` from origin and stores it as a base: the trees first, then the blobs by id in batches, each
 * batch appended to the content in path order. Holds at most one part and one batch at a time.
 */
export const buildBase = async (
  bucket: R2Bucket,
  origin: Origin,
  repo: string,
  commit: string,
): Promise<Manifest> => {
  const prefix = basePrefix(repo, commit);
  const trees = await fetchPack(origin, [`want ${commit}`, "deepen 1", "filter blob:none"]);
  const objects = readPack(trees.pack);
  const tip = objects.find((object) => object.oid === commit);
  if (tip === undefined) throw new Error(`origin sent no commit ${commit}`);
  const files = listFiles(tip, new Map(objects.map((object) => [object.oid, object])));
  const pack = `pack-${hexOf(trees.pack.subarray(trees.pack.length - 20))}`;
  await bucket.put(`${prefix}/${pack}.pack`, trees.pack);
  await bucket.put(`${prefix}/${pack}.idx`, packIndex(objects, trees.pack));

  const blobs = [
    ...new Set(files.filter((file) => file.mode !== "160000").map((file) => file.oid)),
  ];
  const links = new Set(files.filter((file) => file.mode === "120000").map((file) => file.oid));
  const placed = new Map<string, { part: number; offset: number; size: number }>();
  const parts: number[] = [];
  let buffer: Uint8Array[] = [];
  let filled = 0;
  const flush = async () => {
    if (filled === 0) return;
    const bytes = new Uint8Array(filled);
    let at = 0;
    for (const chunk of buffer) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    await bucket.put(`${prefix}/content-${parts.length}`, bytes);
    parts.push(filled);
    buffer = [];
    filled = 0;
  };
  for (let start = 0; start < blobs.length; start += BLOBS_PER_FETCH) {
    const wanted = blobs.slice(start, start + BLOBS_PER_FETCH);
    const fetched = new Map(
      readPack(
        (
          await fetchPack(
            origin,
            wanted.map((oid) => `want ${oid}`),
          )
        ).pack,
      ).map((o) => [o.oid, o.data]),
    );
    for (const oid of wanted) {
      const data = fetched.get(oid);
      if (data === undefined) throw new Error(`origin left blob ${oid} out of a fetch`);
      // A link into the git directory would let a read of the work tree reach the git config.
      if (links.has(oid) && isGitPath(new TextDecoder().decode(data)))
        throw new Error(`a symbolic link in ${repo} points into a git directory`);
      if (filled > 0 && filled + data.length > PART_BYTES) await flush();
      placed.set(oid, { part: parts.length, offset: filled, size: data.length });
      buffer.push(data);
      filled += data.length;
    }
  }
  await flush();

  const entries: FileEntry[] = files.map((file: Entry) => {
    const at = placed.get(file.oid);
    const mode = file.mode;
    if (!isMode(mode)) throw new Error(`${repo} has ${file.path} with git mode ${mode}`);
    return {
      path: file.path,
      mode,
      oid: file.oid,
      size: at?.size ?? 0,
      ...(at === undefined ? {} : { part: at.part, offset: at.offset }),
    };
  });
  await bucket.put(
    `${prefix}/files.json.gz`,
    await gzip(new TextEncoder().encode(JSON.stringify(entries))),
  );
  const manifest: Manifest = {
    version: 1,
    commit,
    time: commitTime(tip.data),
    shallow: trees.shallow,
    parts,
    pack,
  };
  await bucket.put(`${prefix}/manifest.json`, JSON.stringify(manifest));
  return manifest;
};

/** Node-style stats for a base path, the same for every session, so a generated index always matches them. */
export type BaseStats = {
  readonly kind: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly size: number;
  readonly ino: number;
  readonly time: number;
};

const MODES: Record<Mode, number> = {
  "100644": 0o100644,
  "100755": 0o100755,
  "120000": 0o120000,
  "160000": 0o40755,
};

/** A loaded base: its entries in memory, its content read by range from R2. */
export class Base {
  readonly entries: ReadonlyArray<FileEntry>;
  readonly #byPath: ReadonlyMap<string, number>;
  readonly #blobs: ReadonlyMap<string, number>;
  readonly #children: ReadonlyMap<string, ReadonlyArray<string>>;
  #treeOids: Promise<ReadonlySet<string>> | undefined;
  #index: Uint8Array | undefined;

  readonly bucket: R2Bucket;
  readonly prefix: string;
  readonly manifest: Manifest;

  constructor(
    bucket: R2Bucket,
    prefix: string,
    manifest: Manifest,
    entries: ReadonlyArray<FileEntry>,
  ) {
    this.bucket = bucket;
    this.prefix = prefix;
    this.manifest = manifest;
    this.entries = entries;
    this.#byPath = new Map(entries.map((entry, at) => [entry.path, at]));
    this.#blobs = new Map(
      entries.flatMap((entry, at) => (entry.part === undefined ? [] : [[entry.oid, at]])),
    );
    const children = new Map<string, Set<string>>([["", new Set()]]);
    for (const entry of entries) {
      const names = entry.path.split("/");
      for (let depth = 0; depth < names.length; depth += 1) {
        const parent = names.slice(0, depth).join("/");
        const set = children.get(parent) ?? new Set();
        set.add(names[depth] ?? "");
        children.set(parent, set);
      }
      // A gitlink is an empty directory in the work tree.
      if (entry.mode === "160000" && !children.has(entry.path)) children.set(entry.path, new Set());
    }
    this.#children = new Map([...children].map(([dir, names]) => [dir, [...names].toSorted()]));
  }

  /** The entry at a repo-relative path, if the base has a file, link or gitlink there. */
  entry(path: string): FileEntry | undefined {
    const at = this.#byPath.get(path);
    return at === undefined ? undefined : this.entries[at];
  }

  isDirectory(path: string): boolean {
    return this.#children.has(path);
  }

  /** The names in a base directory, or undefined when it is not one. */
  children(path: string): ReadonlyArray<string> | undefined {
    return this.#children.get(path);
  }

  stats(path: string): BaseStats | undefined {
    const at = this.#byPath.get(path);
    if (at !== undefined) {
      const entry = this.entries[at];
      if (entry === undefined) return undefined;
      const kind =
        entry.mode === "120000" ? "symlink" : entry.mode === "160000" ? "directory" : "file";
      return {
        kind,
        mode: MODES[entry.mode],
        size: entry.size,
        ino: at + 1,
        time: this.manifest.time,
      };
    }
    if (!this.#children.has(path)) return undefined;
    return { kind: "directory", mode: 0o40755, size: 0, ino: 0, time: this.manifest.time };
  }

  /** Whether the base holds an object, blob or tree, so git need not write it. */
  async hasObject(oid: string): Promise<boolean> {
    if (this.#blobs.has(oid)) return true;
    this.#treeOids ??= this.idx().then(idxOids);
    return (await this.#treeOids).has(oid);
  }

  blobEntry(oid: string): FileEntry | undefined {
    const at = this.#blobs.get(oid);
    return at === undefined ? undefined : this.entries[at];
  }

  async read(entry: FileEntry): Promise<Uint8Array> {
    if (entry.part === undefined || entry.offset === undefined || entry.size === 0)
      return new Uint8Array();
    const object = await this.bucket.get(`${this.prefix}/content-${entry.part}`, {
      range: { offset: entry.offset, length: entry.size },
    });
    if (object === null) throw new Error(`the base of ${this.prefix} lost content-${entry.part}`);
    return new Uint8Array(await object.arrayBuffer());
  }

  /** Calls `visit` with each entry's bytes, reading the content in ranges of about SCAN_BYTES. */
  async scan(
    entries: ReadonlyArray<FileEntry>,
    visit: (entry: FileEntry, bytes: Uint8Array) => boolean | void,
  ): Promise<void> {
    const sorted = entries
      .filter((entry) => entry.part !== undefined && entry.offset !== undefined)
      .toSorted((a, b) => (a.part ?? 0) - (b.part ?? 0) || (a.offset ?? 0) - (b.offset ?? 0));
    let at = 0;
    while (at < sorted.length) {
      const first = sorted[at];
      if (first === undefined) break;
      let end = at + 1;
      for (; end < sorted.length; end += 1) {
        const next = sorted[end];
        if (
          next === undefined ||
          next.part !== first.part ||
          (next.offset ?? 0) + next.size - (first.offset ?? 0) > SCAN_BYTES
        )
          break;
      }
      const group = sorted.slice(at, end);
      const last = group[group.length - 1] ?? first;
      const start = first.offset ?? 0;
      const object = await this.bucket.get(`${this.prefix}/content-${first.part}`, {
        range: { offset: start, length: (last.offset ?? 0) + last.size - start },
      });
      if (object === null) throw new Error(`the base of ${this.prefix} lost content-${first.part}`);
      const bytes = new Uint8Array(await object.arrayBuffer());
      for (const entry of group) {
        const from = (entry.offset ?? 0) - start;
        if (visit(entry, bytes.subarray(from, from + entry.size)) === false) return;
      }
      at = end;
    }
  }

  async pack(): Promise<Uint8Array> {
    return this.#get(`${this.manifest.pack}.pack`);
  }

  async idx(): Promise<Uint8Array> {
    return this.#get(`${this.manifest.pack}.idx`);
  }

  /** The git index of the base, with the stats `stats` reports, so git takes every untouched file as unchanged. */
  index(): Uint8Array {
    this.#index ??= gitIndex(
      this.entries.map((entry, at) => ({
        path: entry.path,
        mode: entry.mode,
        oid: entry.oid,
        mtime: this.manifest.time,
        inode: at + 1,
        size: entry.size,
      })),
    );
    return this.#index;
  }

  async #get(name: string): Promise<Uint8Array> {
    const object = await this.bucket.get(`${this.prefix}/${name}`);
    if (object === null) throw new Error(`the base of ${this.prefix} lost ${name}`);
    return new Uint8Array(await object.arrayBuffer());
  }
}

/** The object ids a version 2 pack index lists. */
const idxOids = (idx: Uint8Array): ReadonlySet<string> => {
  const view = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
  const count = view.getUint32(8 + 255 * 4);
  const oids = new Set<string>();
  const start = 8 + 256 * 4;
  for (let n = 0; n < count; n += 1)
    oids.add(hexOf(idx.subarray(start + n * 20, start + n * 20 + 20)));
  return oids;
};

// One copy of each base per isolate, shared by the sessions it runs.
const loaded = new Map<string, Promise<Base | undefined>>();
const LOADED_MAX = 4;

/** The base at `prefix`, or undefined while its manifest is missing. */
export const openBase = (bucket: R2Bucket, prefix: string): Promise<Base | undefined> => {
  const cached = loaded.get(prefix);
  if (cached !== undefined) return cached;
  const opening = (async () => {
    const manifest = await bucket.get(`${prefix}/manifest.json`);
    if (manifest === null) return undefined;
    const files = await bucket.get(`${prefix}/files.json.gz`);
    if (files === null) throw new Error(`the base of ${prefix} has a manifest but no file list`);
    const entries = decodeEntries(new TextDecoder().decode(await gunzip(files.body)));
    return new Base(bucket, prefix, decodeManifest(await manifest.text()), entries);
  })();
  loaded.set(prefix, opening);
  // A missing base is looked up again next time; a loaded one stays, up to LOADED_MAX.
  void opening.then(
    (base) => {
      if (base === undefined) loaded.delete(prefix);
      while (loaded.size > LOADED_MAX) loaded.delete(loaded.keys().next().value ?? prefix);
    },
    () => loaded.delete(prefix),
  );
  return opening;
};
