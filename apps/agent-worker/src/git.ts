import type { Workspace } from "@cloudflare/computer";
import type { GitCliResult } from "@cloudflare/computer/git";

import { parseArgv } from "./argv.ts";
import type { Clone } from "./Checker.ts";
import {
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

/** The blob ids a git index records, by path; dorbs's clone and isomorphic-git write version 2. */
const indexOids = (index: Uint8Array): ReadonlyMap<string, string> => {
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  const oids = new Map<string, string>();
  let at = 12;
  for (let n = view.getUint32(8); n > 0; n -= 1) {
    const oid = Array.from(index.subarray(at + 40, at + 60), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const length = view.getUint16(at + 60) & 0xfff;
    oids.set(new TextDecoder().decode(index.subarray(at + 62, at + 62 + length)), oid);
    at += Math.ceil((62 + length + 1) / 8) * 8;
  }
  return oids;
};

/**
 * git status over the paths the agent changed, printed as Computer's git prints it. A whole-repo status walks every
 * file and holds every index and tree entry at once, which a large repo's cannot afford in 128 MB.
 */
const scopedStatus = async (
  context: GitContext,
  paths: ReadonlyArray<string>,
  args: ReadonlyArray<string>,
): Promise<string> => {
  const { workspace, fs, dir } = context;
  const stage = indexOids(await fs.readBytes(`${dir}/.git/index`));
  const trees = new Map<string, ReadonlyMap<string, string>>();
  const headOid = async (path: string): Promise<string | undefined> => {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!trees.has(parent)) {
      const entries = await workspace.git
        .lsTree({ dir, ref: "HEAD", ...(parent === "" ? {} : { path: parent }) })
        .catch(() => []);
      trees.set(parent, new Map(entries.map((entry) => [entry.path, entry.oid])));
    }
    return trees.get(parent)?.get(path.slice(path.lastIndexOf("/") + 1));
  };
  const lines: string[] = [];
  for (const path of [...paths].toSorted()) {
    const stat = await fs.lstat(`${dir}/${path}`);
    const content =
      stat === undefined
        ? undefined
        : stat.isSymbolicLink()
          ? String(await fs.promises.readlink(`${dir}/${path}`))
          : await fs.readBytes(`${dir}/${path}`);
    const work =
      content === undefined ? undefined : await workspace.git.hashObject({ dir, content });
    const head = await headOid(path);
    const staged = stage.get(path);
    // isomorphic-git's statusMatrix numbers, which Computer's status codes read.
    const h = head === undefined ? 0 : 1;
    const w = work === undefined ? 0 : work === head ? 1 : 2;
    const s = staged === undefined ? 0 : staged === head ? 1 : staged === work ? 2 : 3;
    const index = h === 0 && s > 0 ? "A" : h === 1 && s === 0 ? "D" : h === 1 && s >= 2 ? "M" : " ";
    const tree =
      w === 0 && s > 0 ? "D" : h === 0 && s === 0 && w > 0 ? "?" : w === 2 && s !== 3 ? "M" : " ";
    if (index === " " && tree === " ") continue;
    const short = args.includes("-s") || args.includes("--short");
    const v1 = args.some((arg) => arg === "--porcelain=v1" || arg === "--porcelain=1");
    if (tree === "?") lines.push(short ? ` ? ${path}` : v1 ? `?? ${path}` : `? ${path}`);
    else lines.push(short || v1 ? `${index}${tree} ${path}` : `1 ${index}${tree} ${path}`);
  }
  return lines.length === 0 ? "(no output)" : lines.join("\n");
};

/**
 * The command line to run with whole-repo forms narrowed to the paths the agent changed: `diff` without paths, and
 * `add -A`, `add .` or `add <directory>`, which become the changed paths in them.
 */
const narrowed = async (
  argv: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
  context: GitContext,
): Promise<ReadonlyArray<string>> => {
  const [subcommand, ...args] = argv;
  if (subcommand === "diff" && !args.includes("--")) return [...argv, "--", ...paths];
  if (subcommand !== "add") return argv;
  const flags = args.filter((arg) => arg.startsWith("-") && !["-A", "--all", "--"].includes(arg));
  const all = args.some((arg) => ["-A", "--all"].includes(arg));
  const wanted = all ? [] : pathArgs(args);
  const picked = new Set<string>();
  for (const arg of all ? ["."] : wanted) {
    const dir = arg.replace(/^\.\/?/u, "").replace(/\/+$/u, "");
    const stat = await context.fs.lstat(dir === "" ? context.dir : `${context.dir}/${dir}`);
    if (stat?.isDirectory() !== false || dir === "") {
      for (const path of paths)
        if (dir === "" || path === dir || path.startsWith(`${dir}/`)) picked.add(path);
    } else picked.add(dir);
  }
  return ["add", ...flags, "--", ...picked];
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

/**
 * The objects origin lacks to take `tip`: the ones the session wrote since the clone, walked from `tip` down to the
 * base, which origin has. `seen` holds every object the walk reached, base ones included.
 */
const newObjects = async (
  context: GitContext,
  tip: string,
): Promise<{
  readonly objects: ReadonlyArray<{ readonly type: ObjectType; readonly data: Uint8Array }>;
  readonly seen: ReadonlySet<string>;
}> => {
  const base = await context.fs.base();
  const objects: { type: ObjectType; data: Uint8Array }[] = [];
  const seen = new Set<string>();
  const pending = [tip];
  for (let oid = pending.pop(); oid !== undefined; oid = pending.pop()) {
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (base !== undefined && (await base.hasObject(oid))) continue;
    const path = `${context.dir}/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
    const file = await context.fs.promises.readFile(path).catch(() => undefined);
    if (file === undefined || typeof file === "string")
      throw new Error(`the repo has no object ${oid}, which ${tip} needs`);
    const object = looseObject(file);
    objects.push(object);
    if (object.type === "tree")
      for (const entry of treeEntries(object.data))
        if (entry.mode !== "160000") pending.push(entry.oid);
    if (object.type === "commit")
      for (const line of new TextDecoder().decode(object.data).split("\n\n")[0]?.split("\n") ?? [])
        if (line.startsWith("tree ") || line.startsWith("parent ")) pending.push(line.split(" ")[1] ?? "");
  }
  return { objects, seen };
};

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
    const { objects, seen } = await newObjects(context, commit);
    if (old !== undefined && !seen.has(old)) {
      return failed(
        `Push rejected: origin's ${target} has commits ${source} does not. Push to a new branch, such as git push origin HEAD:${BRANCH_PREFIX}my-change.`,
      );
    }
    const refused = await receivePack(
      origin,
      { branch: target, old: old ?? ZERO, commit },
      writePack(objects),
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
  const { written, deleted } = await context.fs.changes();
  const changed = [...written, ...deleted].toSorted();
  if (subcommand === "status") return scopedStatus(context, changed, args);
  if (subcommand === "commit") {
    const rest = withoutCommitAll(args);
    if (rest !== undefined && changed.length > 0) {
      const staged = await context.workspace.git.cli({
        argv: ["add", "--", ...changed],
        cwd: context.dir,
      });
      if (staged.exitCode !== 0) return cliText(staged);
      return run(["commit", ...rest]);
    }
    if (rest !== undefined) return run(["commit", ...rest]);
  }
  if (subcommand === "diff" && changed.length === 0) return "(no output)";
  if (subcommand === "add") {
    const line = await narrowed(argv, changed, context);
    return line.length <= 2 && line[line.length - 1] === "--" ? "(no output)" : run(line);
  }
  return run(await narrowed(argv, changed, context));
};
