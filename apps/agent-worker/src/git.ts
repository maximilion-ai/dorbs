import type { Workspace } from "@cloudflare/computer";
import type { GitCliResult } from "@cloudflare/computer/git";

import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";

import { parseArgv } from "./argv.ts";
import type { Base } from "./base.ts";
import type { Clone } from "./Checker.ts";
import {
  isBranchName,
  looseObject,
  pushRefs,
  receivePack,
  treeEntries,
  writePack,
  type ObjectType,
} from "./clone.ts";
import type { LayeredFs } from "./layered.ts";

/** The cloned repo git runs in, and how pushes reach origin. */
export type GitContext = {
  readonly workspace: Workspace;
  /** The repo as the session sees it; its changes since the clone bound what status, diff and add look at. */
  readonly fs: LayeredFs;
  readonly dir: string;
  readonly clone: Clone;
  /** Records a branch this session's push created on origin. */
  readonly created: (branch: string) => void;
  /** Origin's registered url, or undefined once the repo is no longer registered. */
  readonly url: string | undefined;
  /** Credentials for origin's url; see GitHub's headers. */
  readonly headers: (url: string) => Promise<Readonly<Record<string, string>> | undefined>;
};

// What the git tool runs. Each reads a bounded set of files: the changed ones, or objects. A command that would
// rewrite or walk the whole work tree, such as checkout of another commit, reset --hard or stash, is refused.
const READS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "tag",
  "describe",
  "shortlog",
  "blame",
  "reflog",
  "show-ref",
  "merge-base",
  "--version",
  "--help",
  "-h",
]);
const WRITES = new Set([
  "add",
  "commit",
  "push",
  "branch",
  "rm",
  "mv",
  "restore",
  "checkout",
  "switch",
]);
const REFUSED: Readonly<Record<string, string>> = {
  reset: "Unstage with git restore --staged <path>, and undo a change with git restore <path>.",
  stash: "Commit your work on a branch instead.",
  merge: "Work on one branch from the clone.",
  rebase: "Work on one branch from the clone.",
  "cherry-pick": "Work on one branch from the clone.",
  revert: "Edit the files back, then commit.",
  clean: "Delete files one by one with git rm or by writing them.",
  grep: "Use the grep tool, which searches the repo.",
  worktree: "The workspace has one work tree.",
};

/** The branch `checkout -b x`, `switch -c x` and their -B and -C forms make at HEAD, when that is all they do. */
const newBranch = (subcommand: string, args: ReadonlyArray<string>): string | undefined => {
  if (subcommand !== "checkout" && subcommand !== "switch") return undefined;
  const flag = args.findIndex((arg) => ["-b", "-B", "-c", "-C"].includes(arg));
  if (flag === -1) return undefined;
  const rest = args.filter((_, at) => at !== flag);
  return rest.length === 1 && !rest[0]?.startsWith("-") ? rest[0] : undefined;
};

/** The paths after `--` in a command line, or every argument that is not a flag when it has no `--`. */
const pathArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const dashes = args.indexOf("--");
  return dashes === -1 ? args.filter((arg) => !arg.startsWith("-")) : args.slice(dashes + 1);
};

/** A path's entry in the index, a tree or the work tree: its object id and mode. */
type Entry = { readonly oid: string; readonly mode: number };

const same = (a: Entry | undefined, b: Entry | undefined): boolean =>
  a?.oid === b?.oid && a?.mode === b?.mode;

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const indexPath = (context: GitContext) => `${context.dir}/.git/index`;

/** Each entry of a version 2 git index, as dorbs's clone and isomorphic-git write it, with its bytes. */
const indexRecords = (
  index: Uint8Array,
): ReadonlyArray<{ readonly path: string; readonly entry: Entry; readonly bytes: Uint8Array }> => {
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  if (view.getUint32(4) !== 2)
    throw new Error(`git index version ${view.getUint32(4)} is not supported`);
  const records = [];
  let at = 12;
  for (let n = view.getUint32(8); n > 0; n -= 1) {
    const length = view.getUint16(at + 60) & 0xfff;
    const size = Math.ceil((62 + length + 1) / 8) * 8;
    records.push({
      path: new TextDecoder().decode(index.subarray(at + 62, at + 62 + length)),
      entry: { oid: hexOf(index.subarray(at + 40, at + 60)), mode: view.getUint32(at + 24) },
      bytes: index.subarray(at, at + size),
    });
    at += size;
  }
  return records;
};

const indexEntries = (index: Uint8Array): ReadonlyMap<string, Entry> =>
  new Map(indexRecords(index).map(({ path, entry }) => [path, entry]));

/**
 * Applies `updates` to the index in one write: each path gets its new entry, or leaves the index where the update is
 * undefined. Computer's git rewrites the whole index once per path, megabytes each in a large repo. New entries carry
 * no stats, so git hashes their files once to compare them.
 */
const updateIndex = async (
  context: GitContext,
  updates: ReadonlyMap<string, Entry | undefined>,
): Promise<void> => {
  const encoder = new TextEncoder();
  const records = indexRecords(await context.fs.readBytes(indexPath(context))).filter(
    (record) => !updates.has(record.path),
  );
  const added = [...updates].flatMap(([path, entry]) => {
    if (entry === undefined) return [];
    const name = encoder.encode(path);
    const bytes = new Uint8Array(Math.ceil((62 + name.length + 1) / 8) * 8);
    const view = new DataView(bytes.buffer);
    view.setUint32(24, entry.mode);
    bytes.set(NodeBuffer.Buffer.from(entry.oid, "hex"), 40);
    view.setUint16(60, Math.min(name.length, 0xfff));
    bytes.set(name, 62);
    return [{ path, bytes }];
  });
  // Git sorts entries by the bytes of their paths.
  // Git sorts entries by the bytes of their paths; each is encoded once.
  const keyed = [...records, ...added].map((record) => ({
    record,
    key: encoder.encode(record.path),
  }));
  const sorted = keyed
    .toSorted((a, b) => NodeBuffer.Buffer.compare(a.key, b.key))
    .map(({ record }) => record);
  const header = new Uint8Array(12);
  header.set(encoder.encode("DIRC"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, sorted.length);
  const body = NodeBuffer.Buffer.concat([header, ...sorted.map((record) => record.bytes)]);
  const digest = NodeCrypto.createHash("sha1").update(body).digest();
  // A new file, not the old one rewritten: isomorphic-git keeps the index it read until the file's stats change,
  // and a rewrite within the same millisecond and size would leave it the stale copy.
  await context.fs.promises.rm(indexPath(context), { force: true });
  await context.fs.promises.writeFile(indexPath(context), NodeBuffer.Buffer.concat([body, digest]));
};

/** Looks paths up in `ref`'s tree, listing each directory once. */
const treeReader = (context: GitContext, ref: string) => {
  const trees = new Map<string, Promise<ReadonlyMap<string, Entry>>>();
  return async (path: string): Promise<Entry | undefined> => {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    let tree = trees.get(parent);
    if (tree === undefined) {
      tree = context.workspace.git
        .lsTree({ dir: context.dir, ref, ...(parent === "" ? {} : { path: parent }) })
        .catch(() => [])
        .then(
          (entries) =>
            new Map(
              entries.map((entry) => [
                entry.path,
                { oid: entry.oid, mode: Number.parseInt(entry.mode, 8) },
              ]),
            ),
        );
      trees.set(parent, tree);
    }
    return (await tree).get(path.slice(path.lastIndexOf("/") + 1));
  };
};

/** What the work tree holds at `path` as git would stage it, or undefined when nothing is there. */
const workEntry = async (
  context: GitContext,
  path: string,
  staged: Entry | undefined,
): Promise<Entry | undefined> => {
  const { fs, dir, workspace } = context;
  const stats = await fs.lstat(`${dir}/${path}`);
  if (stats === undefined) return undefined;
  // A gitlink is an empty directory in the work tree.
  if (stats.isDirectory()) return staged?.mode === 0o160000 ? staged : undefined;
  const link = stats.isSymbolicLink();
  const content = link
    ? String(await fs.promises.readlink(`${dir}/${path}`))
    : await fs.readBytes(`${dir}/${path}`);
  return {
    oid: await workspace.git.hashObject({ dir, content }),
    mode: link ? 0o120000 : (stats.mode & 0o111) === 0 ? 0o100644 : 0o100755,
  };
};

/** The bytes of blob `oid`, from the base when it holds it. */
const blobBytes = async (context: GitContext, oid: string): Promise<Uint8Array> => {
  const base = await context.fs.base();
  const entry = base?.blobEntry(oid);
  if (base !== undefined && entry !== undefined) return base.read(entry);
  return looseObject(
    await context.fs.readBytes(`${context.dir}/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`),
  ).data;
};

/** Puts `entry` in the work tree at `path`, or removes what is there when it is undefined. */
const writeWork = async (context: GitContext, path: string, entry: Entry | undefined) => {
  const { fs, dir } = context;
  const original = (await fs.base())?.entry(path);
  // A directory the session made where the file was goes first, whatever comes back in its place.
  if ((await fs.lstat(`${dir}/${path}`))?.isDirectory() === true && entry?.mode !== 0o160000)
    await fs.promises.rm(`${dir}/${path}`, { recursive: true, force: true });
  if (
    entry !== undefined &&
    original !== undefined &&
    same(entry, { oid: original.oid, mode: Number.parseInt(original.mode, 8) })
  ) {
    // Back to the base's file: the overlay drops its copy, and nothing is copied.
    await fs.revert(`${dir}/${path}`);
    return;
  }
  await fs.promises.rm(`${dir}/${path}`, { recursive: true, force: true });
  if (entry === undefined || entry.mode === 0o160000) return;
  const data = await blobBytes(context, entry.oid);
  if (entry.mode === 0o120000)
    await fs.promises.symlink(new TextDecoder().decode(data), `${dir}/${path}`);
  else
    await fs.promises.writeFile(`${dir}/${path}`, data, {
      mode: (entry.mode & 0o111) === 0 ? 0o644 : 0o755,
    });
};

/**
 * The paths whose HEAD entry is not the base's: what the session's commits changed. Only trees the base lacks are
 * listed, so this reads as many trees as the commits made.
 */
const headChanges = async (context: GitContext, base: Base): Promise<ReadonlyArray<string>> => {
  const head = await context.workspace.git
    .revParse({ dir: context.dir, ref: "HEAD" })
    .catch(() => undefined);
  if (head === undefined || head === base.manifest.commit) return [];
  const changed: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await context.workspace.git
      .lsTree({ dir: context.dir, ref: "HEAD", ...(dir === "" ? {} : { path: dir }) })
      .catch(() => []);
    const names = new Set(entries.map((entry) => entry.path));
    for (const entry of entries) {
      const path = dir === "" ? entry.path : `${dir}/${entry.path}`;
      if (entry.type === "tree") {
        if (!(await base.hasObject(entry.oid))) await walk(path);
        continue;
      }
      const original = base.entry(path);
      if (original?.oid !== entry.oid || original.mode !== entry.mode) changed.push(path);
    }
    for (const name of base.children(dir) ?? []) {
      if (names.has(name)) continue;
      const gone = dir === "" ? name : `${dir}/${name}`;
      for (const original of base.entries)
        if (under(original.path, gone)) changed.push(original.path);
    }
  };
  await walk("");
  return changed;
};

/** What the agent changed since the clone. */
type Changes = {
  readonly written: ReadonlyArray<string>;
  readonly deleted: ReadonlyArray<string>;
  readonly stage: ReadonlyMap<string, Entry>;
  /** Every path whose work tree file, index entry or HEAD entry is not the base's. */
  readonly changed: ReadonlyArray<string>;
};

const changesOf = async (context: GitContext): Promise<Changes> => {
  const { written, deleted } = await context.fs.changes();
  const stage = indexEntries(await context.fs.readBytes(indexPath(context)));
  const base = await context.fs.base();
  const changed = new Set([...written, ...deleted]);
  if (base !== undefined) {
    // Staged and unstaged paths, which no file write shows, such as after git rm --cached.
    for (const [path, entry] of stage) {
      const original = base.entry(path);
      if (!same(entry, original && { oid: original.oid, mode: Number.parseInt(original.mode, 8) }))
        changed.add(path);
    }
    for (const entry of base.entries) if (!stage.has(entry.path)) changed.add(entry.path);
    for (const path of await headChanges(context, base)) changed.add(path);
  }
  return { written, deleted, stage, changed: [...changed].toSorted() };
};

/** A pathspec as a repo-relative path; the whole repo is "". */
const specPath = (spec: string, dir: string): string => {
  const parts: string[] = [];
  for (const part of (spec.startsWith("/") ? spec : `${dir}/${spec}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const path = parts.join("/");
  const root = dir.replace(/^\/+|\/+$/gu, "");
  return path === root ? "" : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
};

const under = (path: string, spec: string): boolean =>
  spec === "" || path === spec || path.startsWith(`${spec}/`);

// One command moves at most this many paths: Computer's git rewrites the index once per path.
const MAX_PATHS = 500;

/**
 * git status over the paths the agent changed, printed as Computer's git prints it. A whole-repo status walks every
 * file and holds every index and tree entry at once, which a large repo's cannot afford in 128 MB.
 */
const scopedStatus = async (
  context: GitContext,
  { changed: paths, stage }: Changes,
  args: ReadonlyArray<string>,
): Promise<string> => {
  const head = treeReader(context, "HEAD");
  const short = args.includes("-s") || args.includes("--short");
  const v1 = args.some((arg) => arg === "--porcelain=v1" || arg === "--porcelain=1");
  const lines: string[] = [];
  for (const path of paths) {
    const staged = stage.get(path);
    const [work, committed] = await Promise.all([workEntry(context, path, staged), head(path)]);
    // git's two columns: the index against HEAD, then the work tree against the index.
    const index = same(staged, committed)
      ? " "
      : committed === undefined
        ? "A"
        : staged === undefined
          ? "D"
          : "M";
    const tree =
      staged === undefined ? " " : work === undefined ? "D" : same(work, staged) ? " " : "M";
    if (index !== " " || tree !== " ")
      lines.push(short || v1 ? `${index}${tree} ${path}` : `1 ${index}${tree} ${path}`);
    // A file the index does not hold is untracked, beside the deletion git stages for it after rm --cached.
    if (staged === undefined && work !== undefined)
      lines.push(short ? ` ? ${path}` : v1 ? `?? ${path}` : `? ${path}`);
  }
  return lines.length === 0 ? "(no output)" : lines.join("\n");
};

/**
 * A diff's command line with its paths cut to the changed ones they name, or all changed ones when it names none;
 * undefined when none is left. Every file outside them is the base's on both sides, so the diff has nothing there.
 */
const narrowedDiff = async (
  args: ReadonlyArray<string>,
  changes: Changes,
  context: GitContext,
): Promise<ReadonlyArray<string> | undefined> => {
  const dashes = args.indexOf("--");
  let options = dashes === -1 ? args : args.slice(0, dashes);
  let specs = dashes === -1 ? [] : args.slice(dashes + 1);
  if (dashes === -1) {
    // As git does, an argument that names a file or a changed path is a path, not a revision.
    const paths: string[] = [];
    for (const arg of options) {
      if (arg.startsWith("-")) continue;
      const path = specPath(arg, context.dir);
      if (
        changes.changed.some((changed) => under(changed, path)) ||
        (await context.fs.lstat(`${context.dir}/${path}`)) !== undefined
      )
        paths.push(arg);
    }
    options = options.filter((arg) => !paths.includes(arg));
    specs = paths;
  }
  const wanted = specs.map((spec) => specPath(spec, context.dir));
  const picked = changes.changed.filter(
    (path) => wanted.length === 0 || wanted.some((spec) => under(path, spec)),
  );
  return picked.length === 0 ? undefined : ["diff", ...options, "--", ...picked];
};

/** Stages `paths` as the work tree has them: an edited or new file is added, a deleted one leaves the index. */
const stagePaths = async (
  paths: ReadonlyArray<string>,
  changes: Changes,
  context: GitContext,
  flags: ReadonlyArray<string> = [],
): Promise<GitCliResult | undefined> => {
  const present: string[] = [];
  const gone: string[] = [];
  for (const path of paths) {
    const stats = await context.fs.lstat(`${context.dir}/${path}`);
    // A directory where a file was tracked is that file deleted; its files are paths of their own.
    const file =
      stats !== undefined && (!stats.isDirectory() || changes.stage.get(path)?.mode === 0o160000);
    if (file) present.push(path);
    else if (changes.stage.has(path)) gone.push(path);
  }
  if (present.length > 0) {
    const result = await context.workspace.git.cli({
      argv: ["add", ...flags, "--", ...present],
      cwd: context.dir,
    });
    if (result.exitCode !== 0) return result;
  }
  if (gone.length > 0) await updateIndex(context, new Map(gone.map((path) => [path, undefined])));
  return undefined;
};

/** `add` of the changed paths its pathspecs name: `add -A` and `add .` stage every change and no other file. */
const added = async (
  args: ReadonlyArray<string>,
  changes: Changes,
  context: GitContext,
): Promise<string> => {
  const flags = args.filter((arg) => arg.startsWith("-") && !["-A", "--all", "--"].includes(arg));
  const all = args.some((arg) => ["-A", "--all"].includes(arg));
  const specs = all ? [""] : pathArgs(args).map((spec) => specPath(spec, context.dir));
  if (specs.length === 0) return failed("Nothing specified, nothing added.");
  const picked = new Set<string>();
  for (const spec of specs) {
    const matched = changes.changed.filter((path) => under(path, spec));
    if (
      matched.length === 0 &&
      spec !== "" &&
      (await context.fs.lstat(`${context.dir}/${spec}`)) === undefined
    )
      return failed(`fatal: pathspec '${spec}' did not match any files`);
    for (const path of matched) picked.add(path);
  }
  if (picked.size > MAX_PATHS)
    return failed(`git add would stage ${picked.size} paths; stage at most ${MAX_PATHS} at once.`);
  const result = await stagePaths([...picked], changes, context, flags);
  return result === undefined ? "(no output)" : cliText(result);
};

/**
 * `rm`: drops tracked paths from the index and, without --cached, from the work tree. As git does, it refuses to lose
 * work that only the index or the work tree holds, unless forced.
 */
const removed = async (
  args: ReadonlyArray<string>,
  changes: Changes,
  context: GitContext,
): Promise<string> => {
  const flags = args.filter((arg) => arg.startsWith("-") && arg !== "--");
  const unknown = flags.find(
    (flag) => !/^-[rfq]+$/u.test(flag) && !["--cached", "--force", "--quiet"].includes(flag),
  );
  if (unknown !== undefined) return failed(`git rm does not take ${unknown} here.`);
  const recursive = flags.some((flag) => /^-[fq]*r/u.test(flag));
  const force = flags.some((flag) => flag === "--force" || /^-[rq]*f/u.test(flag));
  const cached = flags.includes("--cached");
  const paths: string[] = [];
  for (const spec of pathArgs(args).map((arg) => specPath(arg, context.dir))) {
    const tracked = [...changes.stage.keys()].filter((path) => under(path, spec));
    if (tracked.length === 0) return failed(`fatal: pathspec '${spec}' did not match any files`);
    if (!recursive && !tracked.includes(spec))
      return failed(`fatal: not removing '${spec}' recursively without -r`);
    paths.push(...tracked);
  }
  if (paths.length > MAX_PATHS)
    return failed(
      `git rm would remove ${paths.length} paths; remove at most ${MAX_PATHS} at once.`,
    );
  if (!force) {
    const head = treeReader(context, "HEAD");
    for (const path of paths) {
      const staged = changes.stage.get(path);
      const work = await workEntry(context, path, staged);
      const stagedChanged = !same(staged, await head(path));
      const workChanged = work !== undefined && !same(work, staged);
      if (cached && stagedChanged && workChanged)
        return failed(
          `error: the following file has staged content different from both the\nfile and the HEAD:\n    ${path}\n(use -f to force removal)`,
        );
      if (!cached && stagedChanged)
        return failed(
          `error: the following file has changes staged in the index:\n    ${path}\n(use --cached to keep the file, or -f to force removal)`,
        );
      if (!cached && workChanged)
        return failed(
          `error: the following file has local modifications:\n    ${path}\n(use --cached to keep the file, or -f to force removal)`,
        );
    }
  }
  await updateIndex(context, new Map(paths.map((path) => [path, undefined])));
  if (!cached)
    for (const path of paths)
      await context.fs.promises.rm(`${context.dir}/${path}`, { force: true });
  return paths.map((path) => `rm '${path}'`).join("\n");
};

/** `mv` of a tracked file or directory: moves its work tree files, and its index entries as they are. */
const moved = async (
  args: ReadonlyArray<string>,
  changes: Changes,
  context: GitContext,
): Promise<string> => {
  const { fs, dir } = context;
  const flags = args.filter((arg) => arg.startsWith("-") && arg !== "--");
  const unknown = flags.find((flag) => !["-f", "--force", "-v", "--verbose"].includes(flag));
  if (unknown !== undefined) return failed(`git mv does not take ${unknown} here.`);
  const specs = pathArgs(args).map((arg) => specPath(arg, dir));
  const [source, destination] = specs;
  if (specs.length !== 2 || source === undefined || destination === undefined || source === "")
    return failed("git mv takes one source and one destination here.");
  if ((await fs.lstat(`${dir}/${source}`)) === undefined)
    return failed(`fatal: bad source, source=${source}, destination=${destination}`);
  const into = (await fs.lstat(`${dir}/${destination}`))?.isDirectory() === true;
  const target = into ? `${destination}/${source.slice(source.lastIndexOf("/") + 1)}` : destination;
  if (target === source || target.startsWith(`${source}/`))
    return failed(
      `fatal: can not move directory into itself, source=${source}, destination=${target}`,
    );
  const force = flags.includes("-f") || flags.includes("--force");
  if (!force && (await fs.lstat(`${dir}/${target}`)) !== undefined)
    return failed(`fatal: destination exists, source=${source}, destination=${target}`);
  const files = await fs.files(`${dir}/${source}`);
  const tracked = files.filter((file) => changes.stage.has(file));
  if (tracked.length === 0)
    return failed(`fatal: not under version control, source=${source}, destination=${target}`);
  if (files.length > MAX_PATHS)
    return failed(`git mv would move ${files.length} paths; move at most ${MAX_PATHS} at once.`);
  const targetOf = (file: string) => `${target}${file.slice(source.length)}`;
  for (const file of files) {
    const stats = await fs.lstat(`${dir}/${file}`);
    if (stats?.isSymbolicLink() === true)
      await fs.promises.symlink(
        String(await fs.promises.readlink(`${dir}/${file}`)),
        `${dir}/${targetOf(file)}`,
      );
    else
      await fs.promises.writeFile(
        `${dir}/${targetOf(file)}`,
        await fs.readBytes(`${dir}/${file}`),
        {
          mode: ((stats?.mode ?? 0) & 0o111) === 0 ? 0o644 : 0o755,
        },
      );
  }
  await fs.promises.rm(`${dir}/${source}`, { recursive: true, force: true });
  await updateIndex(
    context,
    new Map(
      tracked.flatMap((file) => [
        [file, undefined],
        [targetOf(file), changes.stage.get(file)],
      ]),
    ),
  );
  return "(no output)";
};

/**
 * `restore` and `checkout [<rev>] -- <paths>`, cut to the changed paths they name. The source is the index, or HEAD
 * with --staged, or the revision given; the destinations are the work tree, the index with --staged, or both. A path
 * the source lacks leaves the destinations. Paths the base holds unchanged come back from the base, copying nothing.
 */
const restored = async (
  subcommand: "restore" | "checkout",
  args: ReadonlyArray<string>,
  changes: Changes,
  context: GitContext,
): Promise<string> => {
  const { fs, dir } = context;
  let staged = false;
  let worktree = false;
  let source: string | undefined;
  const specs: string[] = [];
  const dashes = args.indexOf("--");
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? "";
    if (dashes !== -1 && at > dashes) specs.push(arg);
    else if (arg === "--") continue;
    else if (subcommand === "restore" && ["-S", "--staged"].includes(arg)) staged = true;
    else if (subcommand === "restore" && ["-W", "--worktree"].includes(arg)) worktree = true;
    else if (subcommand === "restore" && arg === "-s") source = args[(at += 1)];
    else if (subcommand === "restore" && arg.startsWith("--source=")) source = arg.slice(9);
    else if (arg.startsWith("-")) return failed(`git ${subcommand} does not take ${arg} here.`);
    else if (subcommand === "checkout") source = arg;
    else specs.push(arg);
  }
  if (subcommand === "checkout" && source !== undefined) staged = worktree = true;
  if (!staged) worktree = true;
  source ??= staged ? "HEAD" : undefined;
  if (specs.length === 0) return failed(`git ${subcommand} needs the paths it acts on.`);
  const wanted = specs.map((spec) => specPath(spec, dir));
  // The commit itself: isomorphic-git's tree listing takes no HEAD~1 and the like, and a listing that fails reads
  // as an empty tree, which would remove every path.
  const commit =
    source === undefined
      ? undefined
      : await context.workspace.git.revParse({ dir, ref: source }).catch(() => undefined);
  if (source !== undefined && commit === undefined)
    return failed(`fatal: could not resolve '${source}'`);
  const tree = commit === undefined ? undefined : treeReader(context, commit);
  // A file the source holds counts even when nothing else does, such as one deleted since that commit; a directory
  // counts as the files under it.
  const fromSource = new Set<string>();
  const collect = async (path: string): Promise<void> => {
    const entries = await context.workspace.git
      .lsTree({ dir, ref: commit ?? "HEAD", path })
      .catch(() => []);
    for (const entry of entries) {
      if (fromSource.size > MAX_PATHS) return;
      const child = `${path}/${entry.path}`;
      // As git's verify_path: no empty, dot or slashed names, and nothing in a git directory.
      if (["", ".", ".."].includes(entry.path) || entry.path.includes("/") || isGitPath(child))
        continue;
      if (entry.type === "tree") await collect(child);
      else fromSource.add(child);
    }
  };
  for (const spec of wanted) {
    const entry = spec === "" || tree === undefined ? undefined : await tree(spec);
    if (entry === undefined) continue;
    if (entry.mode === 0o40000) await collect(spec);
    else fromSource.add(spec);
  }
  for (const spec of wanted)
    if (
      ![...fromSource].some((path) => under(path, spec)) &&
      !changes.changed.some((path) => under(path, spec)) &&
      ![...changes.stage.keys()].some((path) => under(path, spec)) &&
      (await fs.lstat(`${dir}/${spec}`)) === undefined
    )
      return failed(`error: pathspec '${spec}' did not match any file(s) known to git`);
  if (wanted.some((spec) => isGitPath(spec)))
    return failed("git does not restore paths in the repo's git directory.");
  const picked = [
    ...new Set([
      ...changes.changed.filter((path) => wanted.some((spec) => under(path, spec))),
      ...fromSource,
    ]),
  ].toSorted();
  if (picked.length > MAX_PATHS)
    return failed(
      `git ${subcommand} would restore ${picked.length} paths; restore at most ${MAX_PATHS} at once.`,
    );
  const from = new Map<string, Entry | undefined>();
  for (const path of picked) {
    const entry = tree === undefined ? changes.stage.get(path) : await tree(path);
    if (entry?.mode === 0o40000) {
      // A directory in the source: its files are picked one by one; what stands in its place goes.
      if ((await fs.lstat(`${dir}/${path}`))?.isDirectory() === false)
        await fs.promises.rm(`${dir}/${path}`, { force: true });
      continue;
    }
    // checkout <rev> leaves a path the revision lacks; only restore removes it.
    if (entry !== undefined || subcommand === "restore") from.set(path, entry);
  }
  if (staged) await updateIndex(context, from);
  if (worktree)
    for (const [path, entry] of from)
      // A path the source lacks leaves the work tree only when git tracks it; untracked files stay.
      if (entry !== undefined || (source !== undefined && changes.stage.has(path)))
        await writeWork(context, path, entry);
  return subcommand === "checkout" ? `Updated ${from.size} paths from the index` : "(no output)";
};

/** `commit -a`, `-am` and `--all` without the stage-all flag, or undefined when the commit has none. */
const withoutCommitAll = (args: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
  let found = false;
  const kept = args.flatMap((arg) => {
    if (arg === "--all") {
      found = true;
      return [];
    }
    if (/^-[a-zA-Z]+$/u.test(arg) && arg.includes("a")) {
      found = true;
      const rest = arg.replaceAll("a", "");
      return rest === "-" ? [] : [rest];
    }
    return [arg];
  });
  return found ? kept : undefined;
};

// The agent owns the network and the remotes; push is the one way out, and the tool runs it.
// config and init write the git config, which steers where a push sends credentials.
const MANAGED = new Set([
  "fetch",
  "pull",
  "clone",
  "remote",
  "config",
  "init",
  "credential",
  "submodule",
]);
const FORCE = new Set(["-f", "--force", "--force-with-lease", "--force-if-includes"]);
const DELETE = new Set(["-d", "--delete"]);
const UPSTREAM = new Set(["-u", "--set-upstream"]);

const PUSH_FORMS =
  "Push with git push, git push origin <branch>, git push -u origin <branch> or git push origin HEAD:<branch>.";

/** A command's output as a terminal shows it, with its exit code when it failed. */
const cliText = ({ stdout, stderr, exitCode }: GitCliResult): string => {
  const parts = [stdout.trimEnd(), stderr.trimEnd(), exitCode === 0 ? "" : `exit ${exitCode}`];
  return parts.filter((part) => part !== "").join("\n") || "(no output)";
};

const failed = (message: string): string => `${message}\nexit 1`;

// The agent's pushes go to branches of their own, so none moves a branch whose CI runs with secrets.
const BRANCH_PREFIX = "dorbs/";

const ZERO = "0".repeat(40);

const loosePath = (context: GitContext, oid: string) =>
  `${context.dir}/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;

/**
 * The objects reachable from `tip` that origin lacks: walked from `tip` down to the base, which origin has, and to
 * `stop`, which it has from an earlier push. Commits and trees come with their data; blobs only by id, so a long
 * history of large files is never held at once. `seen` holds every object the walk reached, stops included.
 */
const newObjects = async (
  context: GitContext,
  tip: string,
  stop: ReadonlySet<string>,
): Promise<{
  readonly objects: ReadonlyArray<{ readonly oid: string; readonly type: ObjectType }>;
  readonly seen: ReadonlySet<string>;
}> => {
  const base = await context.fs.base();
  const objects: { oid: string; type: ObjectType }[] = [];
  const seen = new Set<string>();
  const pending: Array<{ oid: string; type: ObjectType }> = [{ oid: tip, type: "commit" }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { oid, type } = next;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (stop.has(oid) || (base !== undefined && (await base.hasObject(oid)))) continue;
    objects.push({ oid, type });
    if (type === "blob") continue;
    const file = await context.fs.promises.readFile(loosePath(context, oid)).catch(() => undefined);
    if (file === undefined || typeof file === "string")
      throw new Error(`the repo has no object ${oid}, which ${tip} needs`);
    const object = looseObject(file);
    if (object.type === "tree")
      for (const entry of treeEntries(object.data)) {
        if (entry.mode === "160000") continue;
        pending.push({ oid: entry.oid, type: entry.mode === "40000" ? "tree" : "blob" });
      }
    if (object.type === "commit")
      for (const line of new TextDecoder().decode(object.data).split("\n\n")[0]?.split("\n") ??
        []) {
        const [key, value = ""] = line.split(" ");
        if (key === "tree") pending.push({ oid: value, type: "tree" });
        if (key === "parent") pending.push({ oid: value, type: "commit" });
      }
  }
  return { objects, seen };
};

/** The objects, read and inflated one at a time as the pack streams. */
async function* objectData(
  context: GitContext,
  objects: ReadonlyArray<{ readonly oid: string }>,
): AsyncGenerator<{ readonly type: ObjectType; readonly data: Uint8Array }> {
  for (const { oid } of objects) {
    const file = await context.fs.readBytes(loosePath(context, oid));
    yield looseObject(file);
  }
}

/** Whether a path names the git directory or something in it, in any case. */
export const isGitPath = (path: string): boolean =>
  path.split(/[/=:]/u).some((name) => name.toLowerCase() === ".git");

const push = async (args: ReadonlyArray<string>, context: GitContext): Promise<string> => {
  const { workspace, dir, clone } = context;
  const flags = args.filter((word) => word.startsWith("-"));
  const [remote = "origin", refspec, ...extra] = args.filter((word) => !word.startsWith("-"));
  const forced =
    flags.some((flag) => FORCE.has(flag.split("=")[0] ?? flag)) || refspec?.startsWith("+");
  if (forced) {
    return "Force pushes are not allowed. Commit on top of the remote branch and push again.";
  }
  if (flags.some((flag) => DELETE.has(flag)) || refspec?.startsWith(":")) {
    return "Deleting remote branches is not allowed.";
  }
  const unknown = flags.find((flag) => !UPSTREAM.has(flag));
  if (unknown !== undefined) return failed(`git push does not take ${unknown} here. ${PUSH_FORMS}`);
  if (extra.length > 0) return failed(`git push takes one branch. ${PUSH_FORMS}`);
  if (remote !== "origin") {
    return `Only origin takes pushes. It is ${clone.repo}, which the agent cloned; other remotes are not available.`;
  }
  const current = await workspace.git.currentBranch({ dir });
  const [source = current, target = source] = (refspec ?? "").split(":").map((ref) => {
    // isomorphic-git resolves a short remote ref against the remote's refs, so heads/main means main.
    const name = ref.replace(/^(refs\/)?heads\//u, "");
    return name === "HEAD" ? current : name || undefined;
  });
  if (source === undefined || target === undefined) {
    return failed("HEAD is detached. Create a branch with git checkout -b <name>, then push it.");
  }
  if (target.startsWith("refs/")) {
    return `Push to a branch name, such as git push origin HEAD:dorbs/my-change; ${target} is not a branch.`;
  }
  if (target === clone.branch) {
    return `The base branch ${clone.branch} is protected. Create a branch with git checkout -b <name>, commit, then push it.`;
  }
  if (!isBranchName(target)) return failed(`${target} is not a valid branch name.`);
  if (!target.startsWith(BRANCH_PREFIX)) {
    return `Push to a branch under ${BRANCH_PREFIX}, such as git push origin HEAD:${BRANCH_PREFIX}my-change; ${target} is not one.`;
  }
  if (context.url === undefined) return failed(`${clone.repo} is no longer a registered repo.`);
  const commit = await workspace.git.revParse({ dir, ref: source }).catch(() => undefined);
  if (commit === undefined) return failed(`error: src refspec ${source} does not match any`);
  const created = clone.created ?? [];
  try {
    const origin = { url: context.url, headers: await context.headers(context.url) };
    const old = (await pushRefs(origin)).get(target);
    if (!created.includes(target) && old !== undefined) {
      return `${target} already exists on origin, and this session did not create it. Push to a new branch, such as git push origin HEAD:${BRANCH_PREFIX}my-change.`;
    }
    if (old === commit) return "Everything up-to-date";
    // Only what the session wrote goes: origin has the base, and a push that walked it would read the whole repo.
    const pushed =
      old === undefined
        ? new Set<string>()
        : await newObjects(context, old, new Set()).then(
            ({ seen }) => seen,
            () => new Set<string>(),
          );
    const { objects, seen } = await newObjects(context, commit, pushed);
    if (old !== undefined && !seen.has(old)) {
      return failed(
        `Push rejected: origin's ${target} has commits ${source} does not. Push to a new branch, such as git push origin HEAD:${BRANCH_PREFIX}my-change.`,
      );
    }
    const refused = await receivePack(
      origin,
      { branch: target, old: old ?? ZERO, commit },
      writePack(objects.length, objectData(context, objects)),
    );
    if (refused !== undefined) return failed(`Push rejected: ${refused}`);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  if (!created.includes(target)) context.created(target);
  return `Pushed ${target} to origin at ${commit}`;
};

/** Runs one git command line in the cloned repo and returns what the model reads. */
export const git = async (line: string, context: GitContext): Promise<string> => {
  let argv: ReadonlyArray<string>;
  try {
    argv = parseArgv(line);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const [subcommand, ...args] = argv;
  if (subcommand?.startsWith("-") === true && !["--version", "--help", "-h"].includes(subcommand)) {
    return `git runs in the repo root; global options such as ${subcommand} are not supported. Pass the subcommand first.`;
  }
  if (subcommand !== undefined && MANAGED.has(subcommand)) {
    return `git ${subcommand} is not available: the agent manages the network and remotes. Commit your work, then publish it with git push.`;
  }
  const gitPath = args.find(isGitPath);
  if (gitPath !== undefined) {
    return failed(`git does not take paths in the repo's git directory, such as ${gitPath}.`);
  }
  if (subcommand === "push") return push(args, context);
  if (subcommand !== undefined && subcommand in REFUSED) {
    return failed(`git ${subcommand} is not available here. ${REFUSED[subcommand]}`);
  }
  if (subcommand !== undefined && !READS.has(subcommand) && !WRITES.has(subcommand)) {
    return failed(`git ${subcommand} is not available here.`);
  }
  const run = async (line: ReadonlyArray<string>) =>
    cliText(await context.workspace.git.cli({ argv: [...line], cwd: context.dir }));
  const branch = subcommand === undefined ? undefined : newBranch(subcommand, args);
  if (branch !== undefined) {
    // A new branch at HEAD changes no file, so it only writes refs; checkout would walk the whole work tree.
    const made = await context.workspace.git.cli({ argv: ["branch", branch], cwd: context.dir });
    if (made.exitCode !== 0) return cliText(made);
    await context.fs.promises.writeFile(`${context.dir}/.git/HEAD`, `ref: refs/heads/${branch}\n`);
    return `Switched to a new branch '${branch}'`;
  }
  if (
    (subcommand === "checkout" || subcommand === "switch") &&
    !(subcommand === "checkout" && args.includes("--"))
  ) {
    return failed(
      "Only new branches at HEAD (git checkout -b <name>) and restoring paths (git checkout -- <path>) are available; switching to another commit would rewrite the whole work tree.",
    );
  }
  if (
    (subcommand === "rm" || subcommand === "mv" || subcommand === "restore") &&
    pathArgs(args).length === 0
  ) {
    return failed(`git ${subcommand} needs the paths it acts on.`);
  }
  if (subcommand === "diff" && args.some((arg) => arg === "--cached" || arg === "--staged"))
    return failed(
      "git diff --cached is not available here. git status shows the staged paths, and git diff HEAD -- <path> shows a path's changes since the last commit.",
    );
  // Only commands that compare the work tree, the index and HEAD read the index and the change set.
  if (
    subcommand === undefined ||
    !["status", "diff", "add", "rm", "mv", "restore", "checkout", "commit"].includes(subcommand)
  )
    return run(argv);
  const changes = await changesOf(context);
  switch (subcommand) {
    case "status":
      return scopedStatus(context, changes, args);
    case "diff": {
      const line = await narrowedDiff(args, changes, context);
      return line === undefined ? "(no output)" : run(line);
    }
    case "add":
      return added(args, changes, context);
    case "rm":
      return removed(args, changes, context);
    case "mv":
      return moved(args, changes, context);
    case "restore":
    case "checkout":
      return restored(subcommand, args, changes, context);
    case "commit": {
      const rest = withoutCommitAll(args);
      if (rest === undefined) return run(argv);
      // As git's -a: tracked files only, deletions included; a new file waits for git add.
      const tracked = [...changes.written, ...changes.deleted].filter((path) =>
        changes.stage.has(path),
      );
      const staged = await stagePaths(tracked, changes, context);
      return staged === undefined ? run(["commit", ...rest]) : cliText(staged);
    }
    default:
      return run(argv);
  }
};
