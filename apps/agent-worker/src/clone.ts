import * as NodeCrypto from "node:crypto";

import * as pako from "pako";

/**
 * Git's smart HTTP protocol v2 as clone_repo needs it, and packfile reading. Fetches never hold a repo's whole pack,
 * which overruns a Durable Object's 128 MB on a large repo: base.ts fetches the tip commit and its trees with
 * `filter blob:none`, then the blobs by id in batches.
 */

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

/** A fetch whose pack, packed or inflated, outgrew the bytes its caller allowed; ask for fewer objects. */
export class PackTooLarge extends Error {}

const command = async (
  origin: Origin,
  name: string,
  args: ReadonlyArray<string>,
  limit = Number.POSITIVE_INFINITY,
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
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    received += read.value.length;
    if (received > limit) {
      await reader.cancel();
      throw new PackTooLarge(`origin's answer to ${name} passed ${limit} bytes`);
    }
    chunks.push(read.value);
  }
  return concat(chunks);
};

/** The commit origin's HEAD points at and the branch it names. */
export const head = async (
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
export const fetchPack = async (
  origin: Origin,
  args: ReadonlyArray<string>,
  limit?: number,
): Promise<{ readonly pack: Uint8Array; readonly shallow: ReadonlyArray<string> }> => {
  const response = await command(
    origin,
    "fetch",
    ["no-progress", "ofs-delta", ...args, "done"],
    limit,
  );
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
export type ObjectType = (typeof TYPES)[keyof typeof TYPES];

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
export const readPack = (
  pack: Uint8Array,
  limit = Number.POSITIVE_INFINITY,
): ReadonlyArray<PackObject> => {
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
  let inflated = 0;
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
    inflated += data.length;
    if (inflated > limit) throw new PackTooLarge(`the pack inflates past ${limit} bytes`);
    if (data.length !== size) throw new Error(`packfile object at ${offset} has the wrong size`);
    const crc = crc32(pack.subarray(offset, at));
    if (kind === 6) {
      const base = baseOffset === undefined ? undefined : byOffset.get(baseOffset);
      if (base === undefined) throw new Error(`packfile delta at ${offset} has no base`);
      const resolved = applyDelta(base.data, data);
      inflated += resolved.length;
      if (inflated > limit) throw new PackTooLarge(`the pack inflates past ${limit} bytes`);
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
    inflated += resolved.length;
    if (inflated > limit) throw new PackTooLarge(`the pack inflates past ${limit} bytes`);
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

export type Entry = { readonly path: string; readonly mode: string; readonly oid: string };

export const treeEntries = (
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
export const listFiles = (
  commit: PackObject,
  objects: ReadonlyMap<string, PackObject>,
): ReadonlyArray<Entry> => {
  const tree = /^tree ([0-9a-f]{40})/u.exec(decoder.decode(commit.data))?.[1];
  if (tree === undefined) throw new Error("the commit names no tree");
  const files: Entry[] = [];
  const walk = (oid: string, prefix: string) => {
    const object = objects.get(oid);
    if (object?.type !== "tree") throw new Error(`origin sent no tree ${oid}`);
    const names = new Set<string>();
    for (const entry of treeEntries(object.data)) {
      // Git's fsck refuses these; a clone that writes files from a tree refuses them too.
      const unsafe = ["", ".", ".."].includes(entry.name) || /[/\\\0]/u.test(entry.name);
      if (unsafe || entry.name.toLowerCase() === ".git" || names.has(entry.name)) {
        throw new Error(`origin's tree has an entry named ${JSON.stringify(entry.name)}`);
      }
      names.add(entry.name);
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

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** The type and content of a loose object file. */
export const looseObject = (
  file: Uint8Array,
): { readonly type: ObjectType; readonly data: Uint8Array } => {
  const raw = pako.inflate(file);
  const nul = raw.indexOf(0);
  const name = decoder.decode(raw.subarray(0, raw.indexOf(0x20)));
  const type = Object.values(TYPES).find((known) => known === name);
  if (type === undefined) throw new Error(`loose object of unknown type ${name}`);
  return { type, data: raw.subarray(nul + 1) };
};

/** A packfile of `count` whole objects, as receive-pack takes them, streamed as `objects` yields them. */
export const writePack = (
  count: number,
  objects: AsyncIterable<{ readonly type: ObjectType; readonly data: Uint8Array }>,
): ReadableStream<Uint8Array> => {
  const hash = NodeCrypto.createHash("sha1");
  const iterator = objects[Symbol.asyncIterator]();
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const emit = (bytes: Uint8Array) => {
        hash.update(bytes);
        controller.enqueue(bytes);
      };
      if (!started) {
        started = true;
        const header = new Uint8Array(12);
        header.set(encoder.encode("PACK"));
        new DataView(header.buffer).setUint32(4, 2);
        new DataView(header.buffer).setUint32(8, count);
        emit(header);
        return;
      }
      const next = await iterator.next();
      if (next.done === true) {
        controller.enqueue(new Uint8Array(hash.digest()));
        controller.close();
        return;
      }
      const { type, data } = next.value;
      const head = [(TYPE_CODES[type] << 4) | (data.length & 15)];
      for (let size = data.length >>> 4; size > 0; size >>>= 7) {
        head[head.length - 1] = (head.at(-1) ?? 0) | 0x80;
        head.push(size & 0x7f);
      }
      emit(Uint8Array.from(head));
      emit(pako.deflate(data));
    },
  });
};

/** The branches origin advertises to a push, by name, with the commits they point at. */
export const pushRefs = async (origin: Origin): Promise<ReadonlyMap<string, string>> => {
  const response = await fetch(`${origin.url}/info/refs?service=git-receive-pack`, {
    headers: { "user-agent": "git/dorbs", ...origin.headers },
  });
  if (!response.ok) throw new Error(`origin answered HTTP ${response.status} to a ref listing`);
  // The advertisement is binary pkt-lines; its ref names are UTF-8.
  const body = decoder.decode(await response.arrayBuffer());
  const advertised = body.matchAll(/([0-9a-f]{40}) refs\/heads\/([^\0\n]+)/gu);
  return new Map(
    [...advertised].flatMap(([, oid, branch]) =>
      branch === undefined || oid === undefined ? [] : [[branch, oid]],
    ),
  );
};

/**
 * Moves origin's `branch` from `old` (zeros when it is new) to `commit` and sends `pack`, which holds the objects
 * origin lacks. Returns the reason origin gave when it refused either.
 */
/** Whether `name` is a branch name git's check-ref-format takes, and short; nothing else goes on a pkt-line. */
export const isBranchName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 255 &&
  !/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|\/\.|\.lock(?:\/|$)|^[./]|[./]$/u.test(name);

export const receivePack = async (
  origin: Origin,
  update: { readonly branch: string; readonly old: string; readonly commit: string },
  pack: ReadableStream<Uint8Array>,
): Promise<string | undefined> => {
  if (!isBranchName(update.branch)) throw new Error(`${update.branch} is not a branch name`);
  const command = pktLine(
    `${update.old} ${update.commit} refs/heads/${update.branch}\0report-status agent=git/dorbs\n`,
  );
  const response = await fetch(`${origin.url}/git-receive-pack`, {
    method: "POST",
    headers: {
      "content-type": "application/x-git-receive-pack-request",
      accept: "application/x-git-receive-pack-result",
      "user-agent": "git/dorbs",
      ...origin.headers,
    },
    body: pack.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        start: (controller) => controller.enqueue(encoder.encode(`${command}0000`)),
      }),
    ),
  });
  if (!response.ok) return `origin answered HTTP ${response.status}`;
  const lines = [...pktLines(new Uint8Array(await response.arrayBuffer()))].flatMap((pkt) =>
    pkt.kind === "data" ? [decoder.decode(pkt.data).trimEnd()] : [],
  );
  const unpack = lines.find((line) => line.startsWith("unpack "));
  if (unpack !== "unpack ok") return unpack ?? "origin sent no report";
  const status = lines.find((line) => line.startsWith("ok ") || line.startsWith("ng "));
  if (status === undefined) return "origin reported nothing about the branch";
  return status.startsWith("ok ") ? undefined : status.split(" ").slice(2).join(" ");
};
