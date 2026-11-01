import {
  type Entry,
  fetchPack,
  gitIndex,
  listFiles,
  type Origin,
  packIndex,
  type PackObject,
  PackTooLarge,
  readPack,
} from "./clone.ts";
import * as Schema from "effect/Schema";

import { isGitPath } from "./git.ts";
import { filesWith, indexPart, type Plan } from "./words.ts";

/**
 * A repo at one commit, stored once in R2 and shared by the sessions that clone it, so no session's SQLite holds
 * the repo. Under `base2/<repo>/<commit>/`: `files.json.gz` (entries by path), the commit's trees as `<pack>.pack`
 * and `.idx`, and `manifest.json`, written last. File contents sit in parts of about 8 MB, each with a word index
 * beside it for grep. A base reuses the parts of the repo's latest base for the files it shares with it, so a clone
 * after main moved fetches only the changed files.
 */

// A build holds about a part, a fetch's pack and its blobs at once, and a Worker has 128 MB.
const PART_BYTES = 8 * 1024 * 1024;
// A fetch of more than one blob holds at most this, packed and again inflated; it doubles while well under.
const FETCH_BYTES = 8 * 1024 * 1024;
const MAX_BLOBS = 200;
// Grep reads the content in ranges of about this size rather than file by file.
const SCAN_BYTES = 8 * 1024 * 1024;
// Grep skips larger files, and so does the word index.
export const GREP_MAX_BYTES = 2 * 1024 * 1024;
// A base reads parts of at most this many other bases, each of which its sessions keep alive; past it, or when under
// half the bytes of the parts it would read are its own files, a build copies what it reuses into parts of its own.
const MAX_OWNERS = 6;

const ModeSchema = Schema.Literals(["100644", "100755", "120000", "160000"]);
export type Mode = typeof ModeSchema.Type;
const isMode = Schema.is(ModeSchema);

/** A tree entry: a file, an executable, a symbolic link (its target is its content) or a gitlink (no content). */
const FileEntrySchema = Schema.Struct({
  path: Schema.String,
  mode: ModeSchema,
  oid: Schema.String,
  size: Schema.Number,
  /** The manifest's part that holds the content. */
  part: Schema.optionalKey(Schema.Number),
  offset: Schema.optionalKey(Schema.Number),
});
export type FileEntry = typeof FileEntrySchema.Type;

/** A content part: its R2 key, with its word index at `<key>.words`, and its size. */
const PartSchema = Schema.Struct({ key: Schema.String, size: Schema.Number });
type Part = typeof PartSchema.Type;

const ManifestV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  commit: Schema.String,
  time: Schema.Number,
  shallow: Schema.Array(Schema.String),
  parts: Schema.Array(Schema.Number),
  pack: Schema.String,
});

const ManifestSchema = Schema.Struct({
  version: Schema.Literal(2),
  commit: Schema.String,
  /** The commit time in milliseconds; every base file's mtime and ctime. */
  time: Schema.Number,
  shallow: Schema.Array(Schema.String),
  parts: Schema.Array(PartSchema),
  /** The trees pack's name, as `pack-<sha>`. */
  pack: Schema.String,
  /** The other bases whose parts this one reads, which live as long as it is used. */
  uses: Schema.Array(Schema.String),
  /** Whether each part has a word index; a version 1 base's have none. */
  indexed: Schema.Boolean,
});
export type Manifest = typeof ManifestSchema.Type;

const decodeEntries = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(FileEntrySchema)),
);
const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Union([ManifestSchema, ManifestV1Schema])),
);

/** A manifest as this version reads it; a version 1 base's parts sit at `content-<n>` under its prefix. */
const current = (prefix: string, manifest: Manifest | typeof ManifestV1Schema.Type): Manifest =>
  manifest.version === 2
    ? manifest
    : {
        ...manifest,
        version: 2,
        parts: manifest.parts.map((size, n) => ({ key: `${prefix}/content-${n}`, size })),
        uses: [],
        indexed: false,
      };

export const basePrefix = (repo: string, commit: string): string => `base2/${repo}/${commit}`;

/** Where the prefix of the repo's most recently built base is kept, which the next build reuses. */
const latestKey = (repo: string): string => `base2/${repo}/latest`;

export const latestBase = async (bucket: R2Bucket, repo: string): Promise<string | undefined> =>
  (await bucket.get(latestKey(repo)))?.text();

/** The base a part was written by, which keeps it. */
export const ownerOf = (key: string): string => key.slice(0, key.lastIndexOf("/content-"));

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

/** Whether grep reads a file: not too large, and no NUL in its first 8 KB. */
export const isText = (bytes: Uint8Array): boolean =>
  bytes.length <= GREP_MAX_BYTES && !bytes.subarray(0, 8192).includes(0);

/**
 * Fetches `commit` from origin and stores it as a base: the trees first, then each file. A file `parent` holds keeps
 * its place in `parent`'s parts, or is copied from there, and only the rest is fetched, by id in batches. New content
 * goes into parts in path order, each written with its word index. Holds at most one part and one batch at a time.
 */
export const buildBase = async (
  bucket: R2Bucket,
  origin: Origin,
  repo: string,
  commit: string,
  parent?: Base,
): Promise<Manifest> => {
  const prefix = basePrefix(repo, commit);
  // A builder that takes over a stalled one writes parts of its own, so the two never mix.
  const build = crypto.randomUUID().slice(0, 8);
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

  // What the parent holds: in place when few bases own it and it fills most of their parts, else copied.
  const held = new Map<string, FileEntry>();
  for (const oid of blobs) {
    const entry = parent?.blobEntry(oid);
    if (entry !== undefined) held.set(oid, entry);
  }
  const heldParts = new Set([...held.values()].map((entry) => entry.part ?? 0));
  const heldBytes = [...held.values()].reduce((sum, entry) => sum + entry.size, 0);
  const partBytes = [...heldParts].reduce(
    (sum, part) => sum + (parent?.manifest.parts[part]?.size ?? 0),
    0,
  );
  const owners = new Set(
    [...heldParts].map((part) => ownerOf(parent?.manifest.parts[part]?.key ?? "")),
  );
  const inPlace =
    parent !== undefined &&
    parent.manifest.indexed &&
    owners.size <= MAX_OWNERS &&
    heldBytes * 2 >= partBytes;

  const parts: Part[] = [];
  const partOf = new Map<string, number>();
  const placed = new Map<string, { part: number; offset: number; size: number }>();
  if (inPlace)
    for (const [oid, entry] of held) {
      const part = parent.manifest.parts[entry.part ?? 0];
      if (part === undefined || entry.offset === undefined) continue;
      let at = partOf.get(part.key);
      if (at === undefined) {
        at = parts.push(part) - 1;
        partOf.set(part.key, at);
      }
      placed.set(oid, { part: at, offset: entry.offset, size: entry.size });
    }

  let buffer: Array<{ readonly offset: number; readonly data: Uint8Array }> = [];
  let filled = 0;
  const flush = async () => {
    if (filled === 0) return;
    const bytes = new Uint8Array(filled);
    const text: Array<{ offset: number; text: string }> = [];
    const decoder = new TextDecoder();
    for (const { offset, data } of buffer) {
      bytes.set(data, offset);
      if (isText(data)) text.push({ offset, text: decoder.decode(data) });
    }
    const key = `${prefix}/content-${build}-${parts.length}`;
    await bucket.put(key, bytes);
    await bucket.put(`${key}.words`, await gzip(new TextEncoder().encode(indexPart(text))));
    parts.push({ key, size: filled });
    buffer = [];
    filled = 0;
  };
  const place = async (oid: string, data: Uint8Array) => {
    if (filled > 0 && filled + data.length > PART_BYTES) await flush();
    placed.set(oid, { part: parts.length, offset: filled, size: data.length });
    buffer.push({ offset: filled, data });
    filled += data.length;
  };

  if (parent !== undefined && !inPlace) {
    // A copy, not a view of the range scan reads, which can then go.
    await parent.scan([...held.values()], (entry, data) => place(entry.oid, data.slice()));
  }

  const wanted = blobs.filter((oid) => !held.has(oid));
  let count = 16;
  for (let start = 0; start < wanted.length;) {
    const batch = wanted.slice(start, start + count);
    // One blob comes whatever its size; more stop at FETCH_BYTES, packed or inflated, and go again in halves.
    const limit = batch.length === 1 ? undefined : FETCH_BYTES;
    let objects: ReadonlyArray<PackObject>;
    try {
      const { pack } = await fetchPack(
        origin,
        batch.map((oid) => `want ${oid}`),
        limit,
      );
      objects = readPack(pack, limit);
    } catch (error) {
      if (!(error instanceof PackTooLarge)) throw error;
      count = Math.ceil(batch.length / 2);
      continue;
    }
    start += batch.length;
    const fetched = new Map(objects.map((o) => [o.oid, o.data]));
    for (const oid of batch) {
      const data = fetched.get(oid);
      if (data === undefined) throw new Error(`origin left blob ${oid} out of a fetch`);
      // A link into the git directory would let a read of the work tree reach the git config.
      if (links.has(oid) && isGitPath(new TextDecoder().decode(data)))
        throw new Error(`a symbolic link in ${repo} points into a git directory`);
      await place(oid, data);
    }
    const got = [...fetched.values()].reduce((sum, data) => sum + data.length, 0);
    if (got < FETCH_BYTES / 2) count = Math.min(MAX_BLOBS, count * 2);
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
    version: 2,
    commit,
    time: commitTime(tip.data),
    shallow: trees.shallow,
    parts,
    pack,
    uses: [...new Set(parts.map((part) => ownerOf(part.key)))].filter((owner) => owner !== prefix),
    indexed: true,
  };
  await bucket.put(`${prefix}/manifest.json`, JSON.stringify(manifest));
  await bucket.put(latestKey(repo), prefix);
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

  #part(entry: FileEntry): Part {
    const part = this.manifest.parts[entry.part ?? -1];
    if (part === undefined) throw new Error(`the base of ${this.prefix} has no part ${entry.part}`);
    return part;
  }

  async read(entry: FileEntry): Promise<Uint8Array> {
    if (entry.part === undefined || entry.offset === undefined || entry.size === 0)
      return new Uint8Array();
    const cached = blobs.get(entry.oid);
    if (cached !== undefined) {
      blobs.delete(entry.oid);
      blobs.set(entry.oid, cached);
      return cached;
    }
    const { key } = this.#part(entry);
    const object = await this.bucket.get(key, {
      range: { offset: entry.offset, length: entry.size },
    });
    if (object === null) throw new Error(`the base of ${this.prefix} lost ${key}`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    remember(entry.oid, bytes);
    return bytes;
  }

  /**
   * The entries that may match a pattern with `plan`: those whose part's word index has, for some alternative, a
   * word containing each piece. All of them when the base has no word index.
   */
  async candidates(
    plan: Plan,
    entries: ReadonlyArray<FileEntry>,
  ): Promise<ReadonlyArray<FileEntry>> {
    if (!this.manifest.indexed) return entries;
    const byPart = Map.groupBy(
      entries.filter((entry) => entry.part !== undefined),
      (entry) => entry.part ?? 0,
    );
    const kept: FileEntry[] = [];
    await Promise.all(
      [...byPart].map(async ([part, inPart]) => {
        const key = this.manifest.parts[part]?.key;
        if (key === undefined) throw new Error(`the base of ${this.prefix} has no part ${part}`);
        const index = await this.#words(key);
        const offsets = new Set<number>();
        for (const pieces of plan) {
          let all: ReadonlySet<number> | undefined;
          for (const piece of pieces) {
            const found = filesWith(index, piece);
            all = all === undefined ? found : new Set([...all].filter((at) => found.has(at)));
            if (all.size === 0) break;
          }
          for (const at of all ?? []) offsets.add(at);
        }
        for (const entry of inPart) if (offsets.has(entry.offset ?? -1)) kept.push(entry);
      }),
    );
    return kept;
  }

  #words(key: string): Promise<string> {
    const cached = indexes.get(key);
    if (cached !== undefined) {
      indexes.delete(key);
      indexes.set(key, cached);
      return cached.text;
    }
    const text = (async () => {
      const object = await this.bucket.get(`${key}.words`);
      if (object === null) throw new Error(`the base of ${this.prefix} lost ${key}.words`);
      return new TextDecoder().decode(await gunzip(object.body));
    })();
    const held = { text, chars: 0 };
    indexes.set(key, held);
    void text.then(
      (value) => {
        held.chars = value.length;
        let total = 0;
        for (const other of indexes.values()) total += other.chars;
        for (const [name, other] of indexes) {
          if (total <= INDEX_CHARS) break;
          total -= other.chars;
          indexes.delete(name);
        }
      },
      () => indexes.delete(key),
    );
    return text;
  }

  /** Calls `visit` with each entry's bytes, reading the content in ranges of about SCAN_BYTES. */
  async scan(
    entries: ReadonlyArray<FileEntry>,
    visit: (entry: FileEntry, bytes: Uint8Array) => boolean | void | Promise<boolean | void>,
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
      const { key } = this.#part(first);
      const object = await this.bucket.get(key, {
        range: { offset: start, length: (last.offset ?? 0) + last.size - start },
      });
      if (object === null) throw new Error(`the base of ${this.prefix} lost ${key}`);
      const bytes = new Uint8Array(await object.arrayBuffer());
      for (const entry of group) {
        const from = (entry.offset ?? 0) - start;
        if ((await visit(entry, bytes.subarray(from, from + entry.size))) === false) return;
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

// Recently read files, by object id, shared by the bases and sessions of the isolate: an edit reads its file twice.
const blobs = new Map<string, Uint8Array>();
const BLOB_BYTES = 8 * 1024 * 1024;
let blobBytes = 0;
const remember = (oid: string, bytes: Uint8Array) => {
  if (bytes.length > BLOB_BYTES / 8 || blobs.has(oid)) return;
  blobs.set(oid, bytes);
  blobBytes += bytes.length;
  for (const [name, held] of blobs) {
    if (blobBytes <= BLOB_BYTES) break;
    blobBytes -= held.length;
    blobs.delete(name);
  }
};

// Parts' word indexes, by part key, decompressed; about 15 MB for all of T3 Code's.
const indexes = new Map<string, { readonly text: Promise<string>; chars: number }>();
const INDEX_CHARS = 16 * 1024 * 1024;

// One copy of each base per isolate, shared by the sessions it runs.
const loaded = new Map<
  string,
  { readonly opening: Promise<Base | undefined>; readonly at: number }
>();
// Each holds a repo's entries and generated index, about 20 MB at T3 Code's size, in a 128 MB isolate.
const LOADED_MAX = 2;
// A base is deleted only after two weeks unused, and every user renews it hourly; one loaded within the hour stands.
const LOADED_MS = 60 * 60 * 1000;

/** Drops the isolate's copy of the base at `prefix`, which RepoBase is deleting. */
export const forgetBase = (prefix: string): void => {
  loaded.delete(prefix);
};

/** The base at `prefix`, or undefined while its manifest is missing. */
export const openBase = (bucket: R2Bucket, prefix: string): Promise<Base | undefined> => {
  const cached = loaded.get(prefix);
  loaded.delete(prefix);
  if (cached !== undefined && Date.now() - cached.at < LOADED_MS) {
    // Least recently used goes first.
    loaded.set(prefix, cached);
    return cached.opening;
  }
  const opening = (async () => {
    const manifest = await bucket.get(`${prefix}/manifest.json`);
    if (manifest === null) return undefined;
    const files = await bucket.get(`${prefix}/files.json.gz`);
    if (files === null) throw new Error(`the base of ${prefix} has a manifest but no file list`);
    const entries = decodeEntries(new TextDecoder().decode(await gunzip(files.body)));
    return new Base(
      bucket,
      prefix,
      current(prefix, decodeManifest(await manifest.text())),
      entries,
    );
  })();
  loaded.set(prefix, { opening, at: Date.now() });
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
