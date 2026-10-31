import type { Workspace } from "@cloudflare/computer";
import type { GitCliResult } from "@cloudflare/computer/git";

import { parseArgv } from "./argv.ts";
import type { Clone } from "./Checker.ts";

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
  return cliText(await context.workspace.git.cli({ argv: [...argv], cwd: context.dir }));
};
