import type { Workspace } from "@cloudflare/computer";
import type { GitCliResult } from "@cloudflare/computer/git";

import { parseArgv } from "./argv.ts";
import type { Clone } from "./Checker.ts";

/** Repo paths the agent's tools wrote since the clone, or "all" once a git command may have changed any file. */
export type Touched = ReadonlyArray<string> | "all";

/** The cloned repo git runs in, and how pushes reach origin. */
export type GitContext = {
  readonly workspace: Workspace;
  readonly dir: string;
  readonly clone: Clone;
  /** Records a branch this session's push created on origin. */
  readonly created: (branch: string) => void;
  /** Origin's registered url, or undefined once the repo is no longer registered. */
  readonly url: string | undefined;
  /** Credentials for origin's url; see GitHub's headers. */
  readonly headers: (url: string) => Promise<Readonly<Record<string, string>> | undefined>;
  readonly touched: () => Touched;
  readonly touch: (paths: Touched) => void;
};

// Subcommands that change no file in the work tree; any other may, so it widens what later commands look at to all.
const LEAVES_FILES = new Set([
  "status",
  "diff",
  "log",
  "show",
  "add",
  "commit",
  "push",
  "branch",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "tag",
  "describe",
  "shortlog",
  "blame",
  "grep",
  "reflog",
  "show-ref",
  "merge-base",
  "--version",
  "--help",
  "-h",
]);

/** Whether `checkout -b x` or `switch -c x` only makes a branch at HEAD, which leaves every file as it is. */
const onlyBranches = (subcommand: string, args: ReadonlyArray<string>): boolean => {
  if (subcommand !== "checkout" && subcommand !== "switch") return false;
  const creates = args.some((arg) => ["-b", "-B", "-c", "-C"].includes(arg));
  return creates && args.filter((arg) => !arg.startsWith("-")).length === 1;
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

const bytesOf = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer());

/**
 * git status over the paths the agent changed, printed as Computer's git prints it. A whole-repo status walks every
 * file and holds every index and tree entry at once, which a large repo's cannot afford in 128 MB.
 */
const scopedStatus = async (
  context: GitContext,
  paths: ReadonlyArray<string>,
  args: ReadonlyArray<string>,
): Promise<string> => {
  const { workspace, dir } = context;
  const stage = indexOids(await bytesOf(await workspace.fs.readFile(`${dir}/.git/index`)));
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
    const stat = await workspace.fs.lstat(`${dir}/${path}`).catch(() => undefined);
    const content =
      stat === undefined
        ? undefined
        : stat.isSymbolicLink
          ? await workspace.fs.readlink(`${dir}/${path}`)
          : await bytesOf(await workspace.fs.readFile(`${dir}/${path}`));
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
 * The command line to run with whole-repo forms narrowed to the paths the agent changed: `diff` without paths,
 * `add -A` or `add .`, and `commit -a`, which stages them first.
 */
const narrowed = (
  argv: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const [subcommand, ...args] = argv;
  if (subcommand === "diff" && !args.includes("--")) return [...argv, "--", ...paths];
  if (subcommand === "add" && args.some((arg) => ["-A", "--all", "."].includes(arg))) {
    return ["add", ...args.filter((arg) => !["-A", "--all", "."].includes(arg)), "--", ...paths];
  }
  return argv;
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

/** The branches origin advertises to a push, from its smart HTTP ref advertisement. */
const remoteBranches = async (
  url: string,
  headers: Readonly<Record<string, string>> | undefined,
): Promise<ReadonlySet<string>> => {
  const response = await fetch(`${url}/info/refs?service=git-receive-pack`, {
    headers: { "user-agent": "git/dorbs", ...headers },
  });
  if (!response.ok) throw new Error(`origin answered HTTP ${response.status} to a ref listing`);
  // The advertisement is binary pkt-lines; its ref names are UTF-8.
  const body = new TextDecoder().decode(await response.arrayBuffer());
  const advertised = body.matchAll(/[0-9a-f]{40} refs\/heads\/([^\0\n]+)/gu);
  return new Set([...advertised].flatMap(([, branch]) => branch ?? []));
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
  // Computer's push takes no proxy of its own, so isomorphic-git would send the credentials to the config's.
  const proxy = await workspace.git.configGet({ dir, path: "http.corsProxy" });
  if (proxy !== undefined) {
    return failed(
      "Push refused: the repo's git config sets http.corsProxy, which would send origin's credentials to another host.",
    );
  }
  const created = clone.created ?? [];
  try {
    const headers = await context.headers(context.url);
    if (!created.includes(target) && (await remoteBranches(context.url, headers)).has(target)) {
      return `${target} already exists on origin, and this session did not create it. Push to a new branch, such as git push origin HEAD:${BRANCH_PREFIX}my-change.`;
    }
    const result = await workspace.git.push({
      dir,
      url: context.url,
      ref: source,
      remoteRef: `refs/heads/${target}`,
      ...(headers === undefined ? {} : { headers: { ...headers } }),
    });
    if (!result.ok) {
      const refErrors = Object.values(result.refs).flatMap((ref) => ref.error ?? []);
      return failed(`Push rejected: ${result.error ?? refErrors.join("; ")}`);
    }
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
  const run = async (line: ReadonlyArray<string>) =>
    cliText(await context.workspace.git.cli({ argv: [...line], cwd: context.dir }));
  if (
    subcommand !== undefined &&
    !LEAVES_FILES.has(subcommand) &&
    !onlyBranches(subcommand, args)
  ) {
    context.touch("all");
  }
  const touched = context.touched();
  if (touched === "all") return run(argv);
  if (subcommand === "status") return scopedStatus(context, touched, args);
  if (subcommand === "commit") {
    const rest = withoutCommitAll(args);
    if (rest !== undefined && touched.length > 0) {
      const staged = await context.workspace.git.cli({
        argv: ["add", "--", ...touched],
        cwd: context.dir,
      });
      if (staged.exitCode !== 0) return cliText(staged);
      return run(["commit", ...rest]);
    }
    if (rest !== undefined) return run(["commit", ...rest]);
  }
  if ((subcommand === "diff" || subcommand === "add") && touched.length === 0) {
    return subcommand === "diff"
      ? "(no output)"
      : run(argv.filter((arg) => !["-A", "--all", "."].includes(arg)));
  }
  return run(narrowed(argv, touched));
};
