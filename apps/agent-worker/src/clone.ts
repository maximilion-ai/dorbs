import * as NodeCrypto from "node:crypto";

import type { Workspace } from "@cloudflare/computer";
import * as pako from "pako";

/**
 * A clone that never holds a repo's whole pack, which overruns a Durable Object's 128 MB on a large repo. It fetches
 * the tip commit and its trees with `filter blob:none`, then the blobs by id in batches, and keeps each pack as git
 * sent it with an index beside it, so isomorphic-git reads any object later.
 */

const BLOBS_PER_FETCH = 200;
const FILE_WRITES_AT_ONCE = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha1 = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const hash = NodeCrypto.createHash("sha1");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const pktLine = (line: string): string =>
  `${(encoder.encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;

type Pkt =
  | { readonly kind: "flush" | "delim" | "end" }
  | { readonly kind: "data"; readonly data: Uint8Array };

function* pktLines(body: Uint8Array): Generator<Pkt> {
  let at = 0;
  while (at + 4 <= body.length) {
    const length = Number.parseInt(decoder.decode(body.subarray(at, at + 4)), 16);
    if (Number.isNaN(length)) throw new Error("origin sent a malformed pkt-line");
    if (length === 0) yield { kind: "flush" };
    else if (length === 1) yield { kind: "delim" };
    else if (length === 2) yield { kind: "end" };
    else yield { kind: "data", data: body.subarray(at + 4, at + length) };
    at += length < 4 ? 4 : length;
  }
}

/** Where a clone's requests go and the credentials they carry. */
export type Origin = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>> | undefined;
};

const command = async (
  origin: Origin,
  name: string,
  args: ReadonlyArray<string>,
): Promise<Uint8Array> => {
  const body =
    pktLine(`command=${name}\n`) +
    pktLine("agent=git/dorbs\n") +
    pktLine("object-format=sha1\n") +
    "0001" +
    args.map((arg) => pktLine(`${arg}\n`)).join("") +
    "0000";
  const response = await fetch(`${origin.url}/git-upload-pack`, {
    method: "POST",
    headers: {
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
      "git-protocol": "version=2",
      "user-agent": "git/dorbs",
      ...origin.headers,
    },
    body,
  });
  if (!response.ok) throw new Error(`origin answered HTTP ${response.status} to ${name}`);
  return new Uint8Array(await response.arrayBuffer());
};

/** The commit origin's HEAD points at and the branch it names. */
const head = async (
  origin: Origin,
): Promise<{ readonly commit: string; readonly branch: string }> => {
  for (const pkt of pktLines(await command(origin, "ls-refs", ["symrefs", "ref-prefix HEAD"]))) {
    if (pkt.kind !== "data") continue;
    const match = /^([0-9a-f]{40}) HEAD symref-target:refs\/heads\/(\S+)/u.exec(
      decoder.decode(pkt.data),
    );
    if (match?.[1] !== undefined && match[2] !== undefined)
      return { commit: match[1], branch: match[2] };
  }
  throw new Error("origin's HEAD names no branch");
};

/** A fetch's packfile and the commits it made shallow. */
const fetchPack = async (
  origin: Origin,
  args: ReadonlyArray<string>,
): Promise<{ readonly pack: Uint8Array; readonly shallow: ReadonlyArray<string> }> => {
  const response = await command(origin, "fetch", ["no-progress", "ofs-delta", ...args, "done"]);
  const shallow: string[] = [];
  const chunks: Uint8Array[] = [];
  let section = "";
  for (const pkt of pktLines(response)) {
    if (pkt.kind !== "data") continue;
    if (section !== "packfile") {
      const line = decoder.decode(pkt.data).trimEnd();
      if (["shallow-info", "acknowledgments", "wanted-refs", "packfile"].includes(line))
        section = line;
      else if (section === "shallow-info" && line.startsWith("shallow "))
        shallow.push(line.slice(8));
      else if (line.startsWith("ERR "))
        throw new Error(`origin refused the fetch: ${line.slice(4)}`);
      continue;
    }
    const band = pkt.data[0];
    if (band === 1) chunks.push(pkt.data.subarray(1));
    else if (band === 3)
      throw new Error(`origin failed the fetch: ${decoder.decode(pkt.data.subarray(1))}`);
  }
  if (chunks.length === 0) throw new Error("origin sent no packfile");
  return { pack: concat(chunks), shallow };
};

const TYPES = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" } as const;
type ObjectType = (typeof TYPES)[keyof typeof TYPES];

export type PackObject = {
  readonly oid: string;
  readonly type: ObjectType;
  readonly data: Uint8Array;
  readonly offset: number;
  readonly crc: number;
};

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** Inflates the zlib stream at `at` and tells how many packed bytes it took. */
const inflateAt = (
  pack: Uint8Array,
  at: number,
): { readonly data: Uint8Array; readonly used: number } => {
  const inflator = new pako.Inflate();
  inflator.push(pack.subarray(at), true);
  if (inflator.err !== 0)
    throw new Error(`packfile object at ${at} does not inflate: ${inflator.msg}`);
  return { data: inflator.result, used: pack.length - at - inflator.strm.avail_in };
};

/** Applies a git delta to its base. */
export const applyDelta = (base: Uint8Array, delta: Uint8Array): Uint8Array => {
  let at = 0;
  const byte = (): number => {
    const value = delta[at];
    if (value === undefined) throw new Error("delta ends early");
    at += 1;
    return value;
  };
  const size = (): number => {
    let value = 0;
    let shift = 1;
    let next: number;
    do {
      next = byte();
      value += (next & 0x7f) * shift;
      shift *= 128;
    } while (next & 0x80);
    return value;
  };
  if (size() !== base.length) throw new Error("delta base has the wrong size");
  const out = new Uint8Array(size());
  let written = 0;
  while (at < delta.length) {
    const op = byte();
    if (op & 0x80) {
      let offset = 0;
      let length = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) offset += byte() * 2 ** (8 * bit);
      for (let bit = 0; bit < 3; bit += 1)
        if (op & (0x10 << bit)) length += byte() * 2 ** (8 * bit);
      if (length === 0) length = 0x10000;
      out.set(base.subarray(offset, offset + length), written);
      written += length;
    } else if (op > 0) {
      out.set(delta.subarray(at, at + op), written);
      written += op;
      at += op;
    } else {
      throw new Error("delta has a reserved opcode");
    }
  }
  if (written !== out.length) throw new Error("delta produced the wrong size");
  return out;
};

const objectId = (type: ObjectType, data: Uint8Array): string =>
  hex(sha1(encoder.encode(`${type} ${data.length}\0`), data));

/** Every object in a pack, deltas resolved; refuses a pack whose trailing checksum does not match. */
const readPack = (pack: Uint8Array): ReadonlyArray<PackObject> => {
  if (decoder.decode(pack.subarray(0, 4)) !== "PACK") throw new Error("not a packfile");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const count = view.getUint32(8);
  if (hex(sha1(pack.subarray(0, pack.length - 20))) !== hex(pack.subarray(pack.length - 20))) {
    throw new Error("packfile checksum does not match");
  }
  const byOffset = new Map<number, PackObject>();
  const byOid = new Map<string, PackObject>();
  const waiting: Array<{ offset: number; end: number; base: string; delta: Uint8Array }> = [];
  const add = (object: PackObject) => {
    byOffset.set(object.offset, object);
    byOid.set(object.oid, object);
  };
  let at = 12;
  for (let n = 0; n < count; n += 1) {
    const offset = at;
    let next = pack[at++] ?? 0;
    const kind = (next >> 4) & 7;
    let size = next & 15;
    let shift = 16;
    while (next & 0x80) {
      next = pack[at++] ?? 0;
      size += (next & 0x7f) * shift;
      shift *= 128;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (kind === 6) {
      next = pack[at++] ?? 0;
      let distance = next & 0x7f;
      while (next & 0x80) {
        next = pack[at++] ?? 0;
        distance = (distance + 1) * 128 + (next & 0x7f);
      }
      baseOffset = offset - distance;
    } else if (kind === 7) {
      baseOid = hex(pack.subarray(at, at + 20));
      at += 20;
    }
    const { data, used } = inflateAt(pack, at);
    at += used;
    if (data.length !== size) throw new Error(`packfile object at ${offset} has the wrong size`);
    const crc = crc32(pack.subarray(offset, at));
    if (kind === 6) {
      const base = baseOffset === undefined ? undefined : byOffset.get(baseOffset);
      if (base === undefined) throw new Error(`packfile delta at ${offset} has no base`);
      const resolved = applyDelta(base.data, data);
      add({ oid: objectId(base.type, resolved), type: base.type, data: resolved, offset, crc });
    } else if (kind === 7) {
      waiting.push({ offset, end: at, base: baseOid ?? "", delta: data });
    } else {
      const type = kind === 1 || kind === 2 || kind === 3 || kind === 4 ? TYPES[kind] : undefined;
      if (type === undefined) throw new Error(`packfile object at ${offset} has type ${kind}`);
      add({ oid: objectId(type, data), type, data, offset, crc });
    }
  }
  // A ref delta may name a base later in the pack.
  while (waiting.length > 0) {
    const ready = waiting.findIndex((entry) => byOid.has(entry.base));
    const entry = waiting[ready];
    if (entry === undefined) throw new Error("packfile delta names a base the pack does not hold");
    waiting.splice(ready, 1);
    const base = byOid.get(entry.base);
    if (base === undefined) continue;
    const resolved = applyDelta(base.data, entry.delta);
    add({
      oid: objectId(base.type, resolved),
      type: base.type,
      data: resolved,
      offset: entry.offset,
      crc: crc32(pack.subarray(entry.offset, entry.end)),
    });
  }
  return [...byOffset.values()];
};

/** A version 2 pack index for `objects`, which isomorphic-git reads to find objects in the pack. */
export const packIndex = (objects: ReadonlyArray<PackObject>, pack: Uint8Array): Uint8Array => {
  const sorted = objects.toSorted((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const n = sorted.length;
  const out = new Uint8Array(8 + 256 * 4 + n * 28 + 40);
  const view = new DataView(out.buffer);
  out.set([0xff, 0x74, 0x4f, 0x63], 0);
  view.setUint32(4, 2);
  const fanout = Array.from({ length: 256 }, () => 0);
  for (const object of sorted) {
    const first = Number.parseInt(object.oid.slice(0, 2), 16);
    fanout[first] = (fanout[first] ?? 0) + 1;
  }
  let running = 0;
  for (let first = 0; first < 256; first += 1) {
    running += fanout[first] ?? 0;
    view.setUint32(8 + first * 4, running);
  }
  const oids = 8 + 256 * 4;
  sorted.forEach((object, i) => {
    out.set(
      Uint8Array.from(object.oid.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16)),
      oids + i * 20,
    );
    view.setUint32(oids + n * 20 + i * 4, object.crc);
    if (object.offset >= 2 ** 31) throw new Error("packfiles over 2 GB are not supported");
    view.setUint32(oids + n * 24 + i * 4, object.offset);
  });
  out.set(pack.subarray(pack.length - 20), oids + n * 28);
  out.set(sha1(out.subarray(0, out.length - 20)), out.length - 20);
  return out;
};

type Entry = { readonly path: string; readonly mode: string; readonly oid: string };

const treeEntries = (
  data: Uint8Array,
): ReadonlyArray<{ mode: string; name: string; oid: string }> => {
  const entries = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0, space);
    entries.push({
      mode: decoder.decode(data.subarray(at, space)),
      name: decoder.decode(data.subarray(space + 1, nul)),
      oid: hex(data.subarray(nul + 1, nul + 21)),
    });
    at = nul + 21;
  }
  return entries;
};

/** The files a commit's trees list, with their modes and blob ids. */
const listFiles = (
  commit: PackObject,
  objects: ReadonlyMap<string, PackObject>,
): ReadonlyArray<Entry> => {
  const tree = /^tree ([0-9a-f]{40})/u.exec(decoder.decode(commit.data))?.[1];
  if (tree === undefined) throw new Error("the commit names no tree");
  const files: Entry[] = [];
  const walk = (oid: string, prefix: string) => {
    const object = objects.get(oid);
    if (object?.type !== "tree") throw new Error(`origin sent no tree ${oid}`);
    for (const entry of treeEntries(object.data)) {
      const path = `${prefix}${entry.name}`;
      if (entry.mode === "40000") walk(entry.oid, `${path}/`);
      else files.push({ path, mode: entry.mode, oid: entry.oid });
    }
  };
  walk(tree, "");
  return files;
};

type IndexEntry = Entry & { readonly mtime: number; readonly inode: number; readonly size: number };

// As isomorphic-git's checkout records them, so its status takes an unchanged file as unchanged without hashing it.
const INDEX_MODES: Record<string, number> = {
  "100644": 0o100644,
  "100755": 0o100755,
  "120000": 0o120000,
  "160000": 0o160000,
};

/** A version 2 git index, laid out as isomorphic-git writes it. */
export const gitIndex = (entries: ReadonlyArray<IndexEntry>): Uint8Array => {
  const sorted = entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(12);
  header.set(encoder.encode("DIRC"), 0);
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, sorted.length);
  parts.push(header);
  for (const entry of sorted) {
    const path = encoder.encode(entry.path);
    const bytes = new Uint8Array(Math.ceil((62 + path.length + 1) / 8) * 8);
    const view = new DataView(bytes.buffer);
    const seconds = Math.floor(entry.mtime / 1000) % 2 ** 32;
    const nanos = Math.floor((entry.mtime - Math.floor(entry.mtime / 1000) * 1000) * 1e6) % 2 ** 32;
    view.setUint32(0, seconds);
    view.setUint32(4, nanos);
    view.setUint32(8, seconds);
    view.setUint32(12, nanos);
    view.setUint32(16, 0);
    view.setUint32(20, entry.inode % 2 ** 32);
    view.setUint32(24, INDEX_MODES[entry.mode] ?? 0o100644);
    view.setUint32(28, 0);
    view.setUint32(32, 0);
    view.setUint32(36, entry.size % 2 ** 32);
    bytes.set(
      Uint8Array.from(entry.oid.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16)),
      40,
    );
    view.setUint16(60, Math.min(path.length, 0xfff));
    bytes.set(path, 62);
    parts.push(bytes);
  }
  const body = concat(parts);
  return concat([body, sha1(body)]);
};

const writePack = async (
  workspace: Workspace,
  gitDir: string,
  pack: Uint8Array,
  objects: ReadonlyArray<PackObject>,
) => {
  const name = `${gitDir}/objects/pack/pack-${hex(pack.subarray(pack.length - 20))}`;
  await workspace.fs.writeFile(`${name}.pack`, pack);
  await workspace.fs.writeFile(`${name}.idx`, packIndex(objects, pack));
};

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

/** Clones origin's HEAD into `dir` at depth 1 and returns the commit and branch it checked out. */
export const shallowClone = async (
  workspace: Workspace,
  origin: Origin,
  dir: string,
): Promise<{ readonly commit: string; readonly branch: string }> => {
  const gitDir = `${dir}/.git`;
  // A clone a restart cut off starts over.
  await workspace.fs.rm(dir, { recursive: true, force: true });
  await workspace.fs.mkdir(`${gitDir}/objects/pack`, { recursive: true });
  const { commit, branch } = await head(origin);

  const trees = await fetchPack(origin, [`want ${commit}`, "deepen 1", "filter blob:none"]);
  const treeObjects = readPack(trees.pack);
  await writePack(workspace, gitDir, trees.pack, treeObjects);
  const tip = treeObjects.find((object) => object.oid === commit);
  if (tip === undefined) throw new Error(`origin sent no commit ${commit}`);
  const files = listFiles(tip, new Map(treeObjects.map((object) => [object.oid, object])));

  const made = new Set<string>([dir]);
  const mkdir = async (path: string) => {
    if (made.has(path)) return;
    await workspace.fs.mkdir(path, { recursive: true });
    for (let at = path; at.length > dir.length; at = parentOf(at)) made.add(at);
  };
  const index: IndexEntry[] = [];
  const record = async (entry: Entry, path: string) => {
    const stat = await workspace.fs.lstat(path);
    index.push({ ...entry, mtime: stat.mtime, inode: stat.inode, size: stat.size });
  };

  // Submodules are gitlinks: a directory in the work tree, recorded in the index, fetched never.
  for (const entry of files.filter((file) => file.mode === "160000")) {
    await mkdir(`${dir}/${entry.path}`);
    await record(entry, `${dir}/${entry.path}`);
  }
  const byBlob = new Map<string, Entry[]>();
  for (const entry of files.filter((file) => file.mode !== "160000")) {
    byBlob.set(entry.oid, [...(byBlob.get(entry.oid) ?? []), entry]);
  }
  const blobs = [...byBlob.keys()];
  for (let start = 0; start < blobs.length; start += BLOBS_PER_FETCH) {
    const wanted = blobs.slice(start, start + BLOBS_PER_FETCH);
    const { pack } = await fetchPack(
      origin,
      wanted.map((oid) => `want ${oid}`),
    );
    const objects = readPack(pack);
    await writePack(workspace, gitDir, pack, objects);
    const writes = objects.flatMap((object) =>
      (byBlob.get(object.oid) ?? []).map((entry) => async () => {
        const path = `${dir}/${entry.path}`;
        await mkdir(parentOf(path));
        if (entry.mode === "120000") await workspace.fs.symlink(decoder.decode(object.data), path);
        else
          await workspace.fs.writeFile(
            path,
            object.data,
            entry.mode === "100755" ? { mode: 0o777 } : {},
          );
        await record(entry, path);
      }),
    );
    if (writes.length < wanted.length) throw new Error("origin left blobs out of a fetch");
    for (let at = 0; at < writes.length; at += FILE_WRITES_AT_ONCE) {
      await Promise.all(writes.slice(at, at + FILE_WRITES_AT_ONCE).map((write) => write()));
    }
  }

  await workspace.fs.writeFile(`${gitDir}/index`, gitIndex(index));
  await workspace.fs.writeFile(`${gitDir}/HEAD`, `ref: refs/heads/${branch}\n`);
  await workspace.fs.mkdir(`${gitDir}/refs/heads`, { recursive: true });
  await workspace.fs.mkdir(`${gitDir}/refs/remotes/origin`, { recursive: true });
  await workspace.fs.mkdir(`${gitDir}/refs/tags`, { recursive: true });
  await workspace.fs.writeFile(`${gitDir}/refs/heads/${branch}`, `${commit}\n`);
  await workspace.fs.writeFile(`${gitDir}/refs/remotes/origin/${branch}`, `${commit}\n`);
  await workspace.fs.writeFile(
    `${gitDir}/refs/remotes/origin/HEAD`,
    `ref: refs/remotes/origin/${branch}\n`,
  );
  if (trees.shallow.length > 0)
    await workspace.fs.writeFile(`${gitDir}/shallow`, `${trees.shallow.join("\n")}\n`);
  await workspace.fs.writeFile(
    `${gitDir}/config`,
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n" +
      `[remote "origin"]\n\turl = ${origin.url}\n\tfetch = +refs/heads/${branch}:refs/remotes/origin/${branch}\n` +
      `[branch "${branch}"]\n\tremote = origin\n\tmerge = refs/heads/${branch}\n`,
  );
  return { commit, branch };
};
