import * as NodeBuffer from "node:buffer";

import type { Base, BaseStats } from "./base.ts";

/**
 * The session's repo: its own writes, in its VFS, over the shared base in R2. Tools and isomorphic-git both use it.
 * A path resolves to nothing under a tombstone, then to the overlay, then to the base; paths the session never wrote
 * cost no SQLite lookup. Base files have fixed stats that match the base's index, and base objects look present at
 * their loose paths, so git hashes no untouched file and a commit writes only new objects.
 */

/** The node fs promises surface the overlay offers and isomorphic-git calls. */
export type FsPromises = {
  readFile(path: string, options?: unknown): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string, options?: unknown): Promise<void>;
  mkdir(path: string, options?: unknown): Promise<unknown>;
  rmdir(path: string, options?: unknown): Promise<void>;
  rm?(path: string, options?: unknown): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
  readdir(path: string, options?: unknown): Promise<string[]>;
  readlink(path: string, options?: unknown): Promise<string | Uint8Array>;
  symlink(target: string, path: string): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
};

export type Stats = {
  readonly mode: number;
  readonly size: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly ctimeMs?: number;
  readonly dev?: number;
  readonly uid?: number;
  readonly gid?: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/** What the overlay holds and the base paths deleted since the clone, as the session keeps them. */
export type OverlayState = {
  /** Repo-relative paths of files, links and directories the session wrote; directories end in a slash. */
  readonly paths: ReadonlyArray<string>;
  readonly tombstones: ReadonlyArray<string>;
};

/** A field of an options object; node fs callers pass an object, a string or nothing. */
const option = (options: unknown, key: string): unknown =>
  typeof options === "object" && options !== null ? Reflect.get(options, key) : undefined;

const codeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;

const exhausted = (place: never): never => {
  throw new Error(`unhandled place ${JSON.stringify(place)}`);
};

const failure = (code: string, path: string): Error =>
  Object.assign(new Error(`${code}: ${path}`), { code, path });

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const parentOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

const ancestors = (path: string): string[] => {
  const out: string[] = [];
  for (let at = parentOf(path); at !== ""; at = parentOf(at)) out.push(at);
  return out;
};

const baseStats = (stats: BaseStats): Stats => ({
  mode: stats.mode,
  size: stats.size,
  ino: stats.ino,
  mtimeMs: stats.time,
  // isomorphic-git reads these four besides mode, size and ino.
  ctimeMs: stats.time,
  dev: 0,
  uid: 0,
  gid: 0,
  isFile: () => stats.kind === "file",
  isDirectory: () => stats.kind === "directory",
  isSymbolicLink: () => stats.kind === "symlink",
});

const deflate = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );

/** Where a path resolves: nowhere, the overlay, a base entry or directory, or a git object the base holds. */
type Place =
  | { readonly at: "none" }
  | { readonly at: "overlay" }
  | { readonly at: "base"; readonly base: Base; readonly path: string }
  | { readonly at: "loose"; readonly base: Base; readonly oid: string }
  | { readonly at: "index"; readonly base: Base }
  | { readonly at: "pack"; readonly base: Base; readonly file: "pack" | "idx" };

export class LayeredFs {
  readonly #overlay: FsPromises;
  readonly #root: string;
  readonly #save: (state: OverlayState) => void;
  /** The repo's base, or undefined before a clone. */
  readonly base: () => Promise<Base | undefined>;
  #paths: Set<string>;
  #dirs: Set<string>;
  #tombstones: Set<string>;
  // A base link's target never changes; this saves an R2 read each time a path goes through one.
  readonly #links = new Map<string, string>();

  constructor(options: {
    readonly overlay: FsPromises;
    readonly root: string;
    readonly state: OverlayState | undefined;
    readonly save: (state: OverlayState) => void;
    readonly base: () => Promise<Base | undefined>;
  }) {
    this.#overlay = options.overlay;
    this.#root = options.root;
    this.#save = options.save;
    this.base = options.base;
    this.#paths = new Set();
    this.#dirs = new Set();
    this.#tombstones = new Set(options.state?.tombstones ?? []);
    for (const path of options.state?.paths ?? []) this.#remember(path);
  }

  /** Forgets the overlay's paths and deletions, as a new clone starts over. */
  reset(): void {
    this.#links.clear();
    this.#paths = new Set();
    this.#dirs = new Set();
    this.#tombstones = new Set();
    this.#persist();
  }

  /** The files the session changed since the clone and the base files it deleted, relative to the repo root. */
  async changes(): Promise<{
    readonly written: ReadonlyArray<string>;
    readonly deleted: ReadonlyArray<string>;
  }> {
    const base = await this.base();
    const deleted = new Set<string>();
    for (const path of this.#tombstones) {
      if (isGit(path)) continue;
      if (base?.entry(path) !== undefined) deleted.add(path);
      else
        for (const entry of base?.entries ?? [])
          if (entry.path.startsWith(`${path}/`)) deleted.add(entry.path);
    }
    // A base file the session turned into a directory is gone as a file.
    for (const dir of this.#dirs) {
      const entry = base?.entry(dir);
      if (entry !== undefined && entry.mode !== "160000") deleted.add(dir);
    }
    for (const path of this.#paths) deleted.delete(path);
    return {
      written: [...this.#paths].filter((path) => !isGit(path)).toSorted(),
      deleted: [...deleted].toSorted(),
    };
  }

  #remember(path: string): void {
    if (path.endsWith("/")) {
      const dir = path.slice(0, -1);
      this.#dirs.add(dir);
      for (const above of ancestors(dir)) this.#dirs.add(above);
    } else {
      this.#paths.add(path);
      for (const above of ancestors(path)) this.#dirs.add(above);
    }
  }

  #persist(): void {
    this.#save({
      paths: [...this.#paths, ...[...this.#dirs].map((dir) => `${dir}/`)],
      tombstones: [...this.#tombstones],
    });
  }

  /** The repo-relative path of an absolute one, or undefined when it is outside the repo. */
  #relative(path: string): string | undefined {
    const normal = normalize(path.startsWith("/") ? path : `${this.#root}/${path}`);
    if (normal === this.#root) return "";
    return normal.startsWith(`${this.#root}/`) ? normal.slice(this.#root.length + 1) : undefined;
  }

  #deleted(path: string): boolean {
    if (this.#tombstones.has(path)) return true;
    return ancestors(path).some((above) => this.#tombstones.has(above));
  }

  #inOverlay(path: string): boolean {
    return path === "" || this.#paths.has(path) || this.#dirs.has(path);
  }

  /** The target of the link at a repo-relative path, or undefined when no link is there. */
  async #linkTarget(path: string): Promise<string | undefined> {
    if (this.#deleted(path) || this.#dirs.has(path)) return undefined;
    if (this.#paths.has(path)) {
      const absolute = `${this.#root}/${path}`;
      const stats = await this.#overlay.lstat(absolute);
      return stats.isSymbolicLink() ? String(await this.#overlay.readlink(absolute)) : undefined;
    }
    const base = await this.base();
    const entry = base?.entry(path);
    if (base === undefined || entry?.mode !== "120000") return undefined;
    const known = this.#links.get(path);
    if (known !== undefined) return known;
    const target = decoder.decode(await base.read(entry));
    this.#links.set(path, target);
    return target;
  }

  /**
   * `absolute` with each link along it followed, in either layer, and the last one too when `follow`. A path that
   * leaves the repo comes back as it is.
   */
  async #resolve(absolute: string, follow: boolean): Promise<string> {
    // Component by component, as a kernel does: a `..` after a link climbs from the link's target.
    let pending = (absolute.startsWith("/") ? absolute : `${this.#root}/${absolute}`).split("/");
    let resolved: string[] = [];
    let hops = 0;
    while (pending.length > 0) {
      const name = pending.shift() ?? "";
      if (name === "" || name === ".") continue;
      if (name === "..") {
        resolved.pop();
        continue;
      }
      resolved.push(name);
      if (!follow && pending.every((rest) => rest === "" || rest === ".")) break;
      const relative = this.#relative(`/${resolved.join("/")}`);
      if (relative === undefined || relative === "" || isGit(relative)) continue;
      const target = await this.#linkTarget(relative);
      if (target === undefined) continue;
      hops += 1;
      if (hops > MAX_LINKS) throw failure("ELOOP", absolute);
      resolved.pop();
      if (target.startsWith("/")) resolved = [];
      pending = [...target.split("/"), ...pending];
    }
    return `/${resolved.join("/")}`;
  }

  /** Throws ENOTDIR when a file or link stands where a directory above `path` would go. */
  async #directoriesAbove(absolute: string, path: string): Promise<void> {
    const base = await this.base();
    for (const above of ancestors(path).toReversed()) {
      if (this.#deleted(above)) return;
      if (this.#dirs.has(above)) continue;
      if (this.#paths.has(above)) throw failure("ENOTDIR", absolute);
      const entry = base?.entry(above);
      if (entry !== undefined && entry.mode !== "160000") throw failure("ENOTDIR", absolute);
      if (!base?.isDirectory(above)) return;
    }
  }

  async #place(absolute: string): Promise<Place> {
    const path = this.#relative(absolute);
    if (path === undefined) return { at: "overlay" };
    if (this.#deleted(path)) return { at: "none" };
    if (this.#paths.has(path)) return { at: "overlay" };
    const base = await this.base();
    if (base !== undefined && isGit(path)) {
      const loose = /^\.git\/objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/u.exec(path);
      if (loose !== null && (await base.hasObject(`${loose[1]}${loose[2]}`)))
        return { at: "loose", base, oid: `${loose[1]}${loose[2]}` };
      if (path === ".git/index") return { at: "index", base };
      if (path === `.git/objects/pack/${base.manifest.pack}.pack`)
        return { at: "pack", base, file: "pack" };
      if (path === `.git/objects/pack/${base.manifest.pack}.idx`)
        return { at: "pack", base, file: "idx" };
      if (/^\.git\/objects\/[0-9a-f]{2}$/u.test(path) && !this.#dirs.has(path))
        return { at: "base", base, path };
    }
    if (this.#dirs.has(path) || path === "") return { at: "overlay" };
    if (base !== undefined && (base.entry(path) !== undefined || base.isDirectory(path)))
      return { at: "base", base, path };
    return { at: "none" };
  }

  /** The bytes of a regular file or link target at a base path. */
  async #baseBytes(base: Base, path: string): Promise<Uint8Array> {
    const entry = base.entry(path);
    if (entry === undefined) throw failure(base.isDirectory(path) ? "EISDIR" : "ENOENT", path);
    return base.read(entry);
  }

  async #read(path: string, follow: boolean): Promise<Uint8Array> {
    const absolute = await this.#resolve(path, follow);
    const place = await this.#place(absolute);
    switch (place.at) {
      case "none":
        throw failure("ENOENT", absolute);
      case "overlay": {
        const data = await this.#overlay.readFile(absolute);
        return typeof data === "string" ? encoder.encode(data) : data;
      }
      case "index":
        return place.base.index();
      case "pack":
        return place.file === "pack" ? place.base.pack() : place.base.idx();
      case "loose": {
        const entry = place.base.blobEntry(place.oid);
        // A tree or the commit: its loose path reads as missing, and git falls back to the base's pack.
        if (entry === undefined) throw failure("ENOENT", absolute);
        const content = await place.base.read(entry);
        const header = encoder.encode(`blob ${content.length}\0`);
        const object = new Uint8Array(header.length + content.length);
        object.set(header);
        object.set(content, header.length);
        return deflate(object);
      }
      case "base":
        return this.#baseBytes(place.base, place.path);
      default:
        return exhausted(place);
    }
  }

  async #stat(path: string, follow: boolean): Promise<Stats> {
    const absolute = await this.#resolve(path, follow);
    const place = await this.#place(absolute);
    switch (place.at) {
      case "none":
        throw failure("ENOENT", absolute);
      case "overlay":
        return follow ? this.#overlay.stat(absolute) : this.#overlay.lstat(absolute);
      case "index":
        return baseStats({
          kind: "file",
          mode: 0o100644,
          size: place.base.index().length,
          ino: 0,
          time: place.base.manifest.time,
        });
      case "pack":
      case "loose":
        return baseStats({
          kind: "file",
          mode: 0o100444,
          size: 0,
          ino: 0,
          time: place.base.manifest.time,
        });
      case "base": {
        if (/^\.git\/objects\/[0-9a-f]{2}$/u.test(place.path))
          return baseStats({
            kind: "directory",
            mode: 0o40755,
            size: 0,
            ino: 0,
            time: place.base.manifest.time,
          });
        const stats = place.base.stats(place.path);
        if (stats === undefined) throw failure("ENOENT", absolute);
        return baseStats(stats);
      }
      default:
        return exhausted(place);
    }
  }

  async #readdir(link: string): Promise<string[]> {
    const absolute = await this.#resolve(link, true);
    const path = this.#relative(absolute);
    if (path === undefined) return this.#overlay.readdir(absolute);
    if (this.#deleted(path)) throw failure("ENOENT", absolute);
    if (this.#paths.has(path)) throw failure("ENOTDIR", absolute);
    const names = new Set<string>();
    const base = await this.base();
    const fromBase = base?.children(path);
    let found = fromBase !== undefined;
    for (const name of fromBase ?? []) names.add(name);
    if (base !== undefined && path === ".git/objects/pack") {
      names.add(`${base.manifest.pack}.pack`);
      names.add(`${base.manifest.pack}.idx`);
      found = true;
    }
    if (this.#inOverlay(path)) {
      const listed = await this.#overlay.readdir(absolute).catch((error: unknown) => {
        if (codeOf(error) === "ENOENT") return [];
        throw error;
      });
      for (const name of listed) names.add(typeof name === "string" ? name : String(name));
      found = true;
    }
    if (!found) {
      if (base?.entry(path) !== undefined || this.#paths.has(path))
        throw failure("ENOTDIR", absolute);
      throw failure("ENOENT", absolute);
    }
    const prefix = path === "" ? "" : `${path}/`;
    return [...names].filter((name) => !this.#tombstones.has(`${prefix}${name}`)).toSorted();
  }

  /** Makes the overlay hold the directories above `path`, which may so far exist only in the base. */
  async #ensureParent(absolute: string, path: string): Promise<void> {
    const parent = parentOf(path);
    if (parent === "" || this.#dirs.has(parent)) return;
    await this.#overlay.mkdir(absolute.slice(0, absolute.lastIndexOf("/")), { recursive: true });
  }

  /**
   * Makes `path` and the directories above it visible again. What a deleted directory held stays deleted, apart from
   * the way down to `path`: from the deleted level down, each level's other base entries get tombstones of their own,
   * and so does all a recreated directory held.
   */
  #revive(path: string, base: Base | undefined): void {
    const chain = [...ancestors(path).toReversed(), path];
    let deleted = false;
    for (const [at, level] of chain.entries()) {
      deleted = this.#tombstones.delete(level) || deleted;
      if (!deleted) continue;
      const next = chain[at + 1];
      for (const name of base?.children(level) ?? []) {
        const child = level === "" ? name : `${level}/${name}`;
        if (child !== next) this.#tombstones.add(child);
      }
    }
  }

  async #write(link: string, data: Uint8Array | string, options?: unknown): Promise<void> {
    const absolute = await this.#resolve(link, true);
    const path = this.#relative(absolute);
    if (path === undefined) return this.#overlay.writeFile(absolute, data, options);
    await this.#directoriesAbove(absolute, path);
    const base = await this.base();
    if (this.#dirs.has(path) || (base?.isDirectory(path) === true && !this.#deleted(path)))
      throw failure("EISDIR", absolute);
    await this.#ensureParent(absolute, path);
    const executable = !this.#paths.has(path) && base?.entry(path)?.mode === "100755";
    const mode =
      typeof options === "object" && options !== null && "mode" in options ? options : undefined;
    await this.#overlay.writeFile(absolute, data, mode ?? (executable ? { mode: 0o755 } : options));
    this.#revive(path, base);
    this.#remember(path);
    this.#persist();
  }

  async #unlink(link: string): Promise<void> {
    const absolute = await this.#resolve(link, false);
    const path = this.#relative(absolute);
    if (path === undefined) return this.#overlay.unlink(absolute);
    const place = await this.#place(absolute);
    if (place.at === "none") throw failure("ENOENT", absolute);
    if (this.#dirs.has(path) || (place.at === "base" && place.base.isDirectory(path)))
      throw failure("EISDIR", absolute);
    if (place.at === "overlay") {
      await this.#overlay.unlink(absolute);
      this.#paths.delete(path);
    }
    const base = await this.base();
    if (base?.entry(path) !== undefined) this.#tombstones.add(path);
    this.#persist();
  }

  async #removeTree(link: string): Promise<void> {
    const absolute = await this.#resolve(link, false);
    const path = this.#relative(absolute);
    if (path === undefined) {
      await (this.#overlay.rm?.(absolute, { recursive: true, force: true }) ??
        this.#overlay.rmdir(absolute, { recursive: true }));
      return;
    }
    if (this.#inOverlay(path)) {
      await (this.#overlay.rm?.(absolute, { recursive: true, force: true }) ??
        this.#overlay.rmdir(absolute, { recursive: true }));
      // The repo root stays, empty, as a clone that starts over expects.
      if (path === "") await this.#overlay.mkdir(absolute, { recursive: true });
    }
    const prefix = `${path}/`;
    for (const known of this.#paths)
      if (known === path || known.startsWith(prefix)) this.#paths.delete(known);
    for (const known of this.#dirs)
      if (known === path || known.startsWith(prefix)) this.#dirs.delete(known);
    const base = await this.base();
    if (base !== undefined && (base.entry(path) !== undefined || base.isDirectory(path)))
      this.#tombstones.add(path);
    this.#persist();
  }

  /** The fs isomorphic-git takes, through Computer's git client's adapter seam. */
  readonly promises: FsPromises & {
    readonly rm: NonNullable<FsPromises["rm"]>;
    readonly chmod: NonNullable<FsPromises["chmod"]>;
  } = {
    readFile: async (path: string, options?: unknown) => {
      if (path === undefined) throw failure("EINVAL", "readFile");
      const bytes = await this.#read(path, true);
      const encoding = typeof options === "string" ? options : option(options, "encoding");
      return encoding === "utf8" || encoding === "utf-8"
        ? decoder.decode(bytes)
        : NodeBuffer.Buffer.from(bytes);
    },
    writeFile: (path, data, options) => this.#write(path, data, options),
    mkdir: async (link, options) => {
      const path = await this.#resolve(link, false);
      const relative = this.#relative(path);
      if (relative === undefined) return this.#overlay.mkdir(path, options);
      await this.#directoriesAbove(path, relative);
      const place = await this.#place(path);
      const recursive = option(options, "recursive") === true;
      if (place.at !== "none") {
        const stats = await this.#stat(path, true).catch(() => undefined);
        if (!recursive || stats?.isDirectory() !== true) throw failure("EEXIST", path);
        return undefined;
      }
      if (place.at === "none" && !recursive && this.#deleted(parentOf(relative)))
        throw failure("ENOENT", path);
      await this.#overlay.mkdir(path, { recursive: true });
      this.#revive(relative, await this.base());
      this.#remember(`${relative}/`);
      this.#persist();
      return undefined;
    },
    rmdir: async (path, options) => {
      if (option(options, "recursive") === true) return this.#removeTree(path);
      const names = await this.#readdir(path);
      if (names.length > 0) throw failure("ENOTEMPTY", path);
      return this.#removeTree(path);
    },
    rm: async (path, options) => {
      const recursive = option(options, "recursive") === true;
      const force = option(options, "force") === true;
      const stats = await this.#stat(path, false).catch((error: unknown) => {
        if (force && codeOf(error) === "ENOENT") return undefined;
        throw error;
      });
      if (stats === undefined) return;
      if (stats.isDirectory()) {
        if (!recursive) throw failure("EISDIR", path);
        return this.#removeTree(path);
      }
      return this.#unlink(path);
    },
    unlink: (path) => this.#unlink(path),
    stat: (path) => this.#stat(path, true),
    lstat: (path) => this.#stat(path, false),
    readdir: (path) => this.#readdir(path),
    readlink: async (link) => {
      const path = await this.#resolve(link, false);
      const place = await this.#place(path);
      if (place.at === "overlay") return this.#overlay.readlink(path);
      if (place.at !== "base" || place.base.entry(place.path)?.mode !== "120000")
        throw failure("EINVAL", path);
      return decoder.decode(await this.#read(path, false));
    },
    symlink: async (target, link) => {
      const path = await this.#resolve(link, false);
      const relative = this.#relative(path);
      if (relative === undefined) return this.#overlay.symlink(target, path);
      await this.#directoriesAbove(path, relative);
      if ((await this.#place(path)).at !== "none") throw failure("EEXIST", path);
      await this.#ensureParent(path, relative);
      await this.#overlay.symlink(target, path);
      this.#revive(relative, await this.base());
      this.#remember(relative);
      this.#persist();
    },
    chmod: async (link, mode) => {
      const path = await this.#resolve(link, true);
      const relative = this.#relative(path);
      if (relative !== undefined && !this.#paths.has(relative)) {
        await this.#write(path, await this.#read(path, false), { mode });
        return;
      }
      await this.#overlay.chmod?.(path, mode);
    },
  };

  // What the agent's tools use.

  readText = async (path: string): Promise<string> => decoder.decode(await this.#read(path, true));

  readBytes = (path: string): Promise<Uint8Array> => this.#read(path, true);

  writeFile = async (path: string, data: Uint8Array | string): Promise<void> =>
    this.#write(path, data);

  lstat = (path: string): Promise<Stats | undefined> =>
    this.#stat(path, false).catch((error: unknown) => {
      if (codeOf(error) === "ENOENT") return undefined;
      throw error;
    });

  /** Shows the base's file at `path` again, dropping what the session wrote or deleted there. */
  async revert(link: string): Promise<void> {
    const absolute = await this.#resolve(link, false);
    const path = this.#relative(absolute);
    if (path === undefined || path === "") throw failure("EINVAL", absolute);
    if (this.#paths.has(path)) {
      await this.#overlay.unlink(absolute);
      this.#paths.delete(path);
    }
    this.#revive(path, await this.base());
    this.#persist();
  }

  /** Every file and link under `dir`, relative to the repo root, the git directory left out. */
  async files(dir: string): Promise<string[]> {
    const path = this.#relative(await this.#resolve(dir, true));
    if (path === undefined) return [];
    const base = await this.base();
    // A file names itself.
    if (
      path !== "" &&
      !this.#deleted(path) &&
      (this.#paths.has(path) || base?.entry(path) !== undefined)
    )
      return [path];
    const prefix = path === "" ? "" : `${path}/`;
    const out = new Set<string>();
    for (const entry of base?.entries ?? []) {
      if (entry.mode === "160000" || isGit(entry.path) || !entry.path.startsWith(prefix)) continue;
      if (!this.#deleted(entry.path)) out.add(entry.path);
    }
    for (const written of this.#paths) {
      if (!isGit(written) && written.startsWith(prefix) && !this.#deleted(written))
        out.add(written);
    }
    return [...out].toSorted();
  }

  /**
   * Lines matching `pattern` in the files under `dir`, at most `limit`. Base files stream from R2 in large ranges;
   * binary files (a NUL in their first 8 KB) and files over `maxBytes` are skipped.
   */
  async grep(
    pattern: RegExp,
    dir: string,
    limit: number,
    maxBytes = 2 * 1024 * 1024,
  ): Promise<
    ReadonlyArray<{ readonly path: string; readonly line: number; readonly text: string }>
  > {
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const search = (path: string, bytes: Uint8Array): boolean => {
      if (bytes.length > maxBytes || bytes.subarray(0, 8192).includes(0)) return true;
      const lines = decoder.decode(bytes).split("\n");
      for (let at = 0; at < lines.length; at += 1) {
        const text = lines[at] ?? "";
        pattern.lastIndex = 0;
        if (pattern.test(text)) {
          matches.push({ path, line: at + 1, text });
          if (matches.length >= limit) return false;
        }
      }
      return true;
    };
    const files = await this.files(dir);
    const base = await this.base();
    const fromBase = files.flatMap((path) => {
      if (this.#paths.has(path)) return [];
      const entry = base?.entry(path);
      return entry !== undefined && entry.mode !== "120000" && entry.size <= maxBytes
        ? [entry]
        : [];
    });
    for (const path of files.filter((file) => this.#paths.has(file))) {
      if (
        !search(
          path,
          await this.#read(`${this.#root}/${path}`, false).catch(() => new Uint8Array()),
        )
      )
        return matches.toSorted(byPathLine);
    }
    if (base !== undefined) await base.scan(fromBase, (entry, bytes) => search(entry.path, bytes));
    return matches.toSorted(byPathLine).slice(0, limit);
  }
}

const byPathLine = (
  a: { path: string; line: number },
  b: { path: string; line: number },
): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line);

// celld's Buffer#indexOf takes about 57 ms on a 3 MB buffer wherever the search starts, and isomorphic-git calls it
// once per index entry, on a Buffer it makes itself: 28 minutes to read T3 Code's index. A byte search goes through
// Uint8Array#indexOf, which takes time in the bytes it scans; other searches keep Buffer's own.
const bufferSearch = NodeBuffer.Buffer.prototype.indexOf;
Object.defineProperty(NodeBuffer.Buffer.prototype, "indexOf", {
  configurable: true,
  writable: true,
  value(this: NodeBuffer.Buffer, value: unknown, offset?: unknown, encoding?: unknown): number {
    if (typeof value === "number" && (offset === undefined || typeof offset === "number"))
      return Uint8Array.prototype.indexOf.call(this, value & 0xff, offset ?? 0);
    return Reflect.apply(bufferSearch, this, [value, offset, encoding]);
  },
});

// As Linux's limit on links followed in one lookup.
const MAX_LINKS = 40;

const isGit = (path: string): boolean => path === ".git" || path.startsWith(".git/");

const normalize = (path: string): string => {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
};
