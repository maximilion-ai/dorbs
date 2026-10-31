import { gitHubRepo, type GitHubRepo } from "@dorbs/protocol/github-app";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { parseArgv } from "./argv.ts";
import { GitHubFailed, type GitHubApi } from "./GitHub.ts";
import type { Clone } from "./Checker.ts";

/** The cloned repo gh works on, and the API it reaches GitHub through. */
export type GhContext = {
  readonly clone: Clone | undefined;
  /** The clone's registered url. */
  readonly url: string | undefined;
  readonly api: GitHubApi | undefined;
  readonly currentBranch: () => Promise<string | undefined>;
};

class Usage extends Schema.TaggedError<Usage>()("Usage", { reason: Schema.String }) {
  override get message(): string {
    return this.reason;
  }
}

const SUPPORTED = [
  "gh pr create --title <title> --body <body> [--base <branch>] [--head <branch>] [--draft]",
  "gh pr view [<number>]",
  "gh pr list [--state open|closed|all]",
  "gh pr comment <number> --body <body>",
  "gh issue view <number>",
  "gh repo view",
];

const PullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  html_url: Schema.String,
  body: Schema.NullOr(Schema.String),
  draft: Schema.optionalKey(Schema.Boolean),
  merged_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  head: Schema.Struct({ ref: Schema.String }),
});
type PullRequest = typeof PullRequest.Type;

const Issue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  html_url: Schema.String,
  body: Schema.NullOr(Schema.String),
});

const Repo = Schema.Struct({
  full_name: Schema.String,
  description: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  default_branch: Schema.String,
});

const Comment = Schema.Struct({ html_url: Schema.String });

type Flags = Readonly<Record<string, string | true>>;

/** Splits gh-style arguments by `spec`, which maps each long flag to its short alias and whether it takes a value. */
const options = (
  args: ReadonlyArray<string>,
  spec: Readonly<Record<string, { readonly short?: string; readonly value: boolean }>>,
): Effect.Effect<{ readonly flags: Flags; readonly positional: ReadonlyArray<string> }, Usage> => {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] ?? "";
    if (!word.startsWith("-") || word === "-") {
      positional.push(word);
      continue;
    }
    const [given = "", inline] = word.startsWith("--") ? word.slice(2).split(/=(.*)/su) : [word];
    const name = word.startsWith("--")
      ? given
      : Object.keys(spec).find((long) => `-${spec[long]?.short}` === given);
    const flag = name === undefined ? undefined : spec[name];
    if (name === undefined || flag === undefined) {
      return Effect.fail(new Usage({ reason: `unknown flag ${word}` }));
    }
    if (!flag.value) {
      flags[name] = true;
      continue;
    }
    const value = inline ?? args[i + 1];
    if (value === undefined) return Effect.fail(new Usage({ reason: `${word} needs a value` }));
    if (inline === undefined) i += 1;
    flags[name] = value;
  }
  return Effect.succeed({ flags, positional });
};

const stringFlag = (flags: Flags, name: string): string | undefined =>
  typeof flags[name] === "string" ? flags[name] : undefined;

const number = (value: string | undefined, usage: string): Effect.Effect<number, Usage> =>
  value !== undefined && /^#?\d+$/u.test(value)
    ? Effect.succeed(Number(value.replace("#", "")))
    : Effect.fail(new Usage({ reason: `usage: ${usage}` }));

const stateOf = (pr: PullRequest): string =>
  pr.merged_at != null
    ? "MERGED"
    : pr.draft === true && pr.state === "open"
      ? "DRAFT"
      : pr.state.toUpperCase();

/** The fields gh prints for `pr view` and `issue view` when its output is not a terminal. */
const viewText = (
  item: { readonly number: number; readonly title: string; readonly html_url: string },
  state: string,
  body: string | null,
): string =>
  [
    `title:\t${item.title}`,
    `state:\t${state}`,
    `number:\t${item.number}`,
    `url:\t${item.html_url}`,
    "--",
    body ?? "",
  ].join("\n");

const make = (context: GhContext, repo: GitHubRepo, api: GitHubApi, base: string) => {
  const { owner, name } = repo;

  const call = <S extends Schema.Constraint>(
    schema: S,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) =>
    api(repo, method, path, body).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError((error) =>
        Schema.isSchemaError(error)
          ? new GitHubFailed({ reason: `GitHub answered ${method} ${path} with an unknown shape` })
          : error,
      ),
    );

  const currentBranch = Effect.promise(context.currentBranch).pipe(
    Effect.flatMap((branch) =>
      branch === undefined
        ? Effect.fail(
            new Usage({ reason: "HEAD is detached. Check out a branch with git checkout -b." }),
          )
        : Effect.succeed(branch),
    ),
  );

  const prCreate = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    const { flags } = yield* options(args, {
      title: { short: "t", value: true },
      body: { short: "b", value: true },
      base: { short: "B", value: true },
      head: { short: "H", value: true },
      draft: { short: "d", value: false },
    });
    const title = stringFlag(flags, "title");
    const body = stringFlag(flags, "body");
    if (title === undefined || body === undefined) {
      return yield* new Usage({
        reason: `--title and --body are required. usage: ${SUPPORTED[0]}`,
      });
    }
    const pr = yield* call(PullRequest, "POST", "/pulls", {
      title,
      body,
      head: stringFlag(flags, "head") ?? (yield* currentBranch),
      base: stringFlag(flags, "base") ?? base,
      draft: flags["draft"] === true,
    });
    return pr.html_url;
  });

  const prView = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    const { positional } = yield* options(args, {});
    if (positional.length > 0) {
      const pr = yield* call(
        PullRequest,
        "GET",
        `/pulls/${yield* number(positional[0], SUPPORTED[1] ?? "")}`,
      );
      return viewText(pr, stateOf(pr), pr.body);
    }
    const branch = yield* currentBranch;
    const query = new URLSearchParams({ head: `${owner}:${branch}`, state: "open" });
    const [pr] = yield* call(Schema.Array(PullRequest), "GET", `/pulls?${query.toString()}`);
    if (pr === undefined) {
      return `no open pull requests found for branch "${branch}". Create one with gh pr create.`;
    }
    return viewText(pr, stateOf(pr), pr.body);
  });

  const prList = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    const { flags } = yield* options(args, { state: { short: "s", value: true } });
    const state = stringFlag(flags, "state") ?? "open";
    if (!["open", "closed", "all"].includes(state)) {
      return yield* new Usage({ reason: `usage: ${SUPPORTED[2]}` });
    }
    const query = new URLSearchParams({ state, per_page: "30" });
    const prs = yield* call(Schema.Array(PullRequest), "GET", `/pulls?${query.toString()}`);
    if (prs.length === 0)
      return `no ${state === "all" ? "" : `${state} `}pull requests in ${owner}/${name}`;
    return prs.map((pr) => `${pr.number}\t${pr.title}\t${pr.head.ref}\t${stateOf(pr)}`).join("\n");
  });

  const prComment = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    const { flags, positional } = yield* options(args, { body: { short: "b", value: true } });
    const pr = yield* number(positional[0], SUPPORTED[3] ?? "");
    const body = stringFlag(flags, "body");
    if (body === undefined) return yield* new Usage({ reason: `usage: ${SUPPORTED[3]}` });
    const comment = yield* call(Comment, "POST", `/issues/${pr}/comments`, { body });
    return comment.html_url;
  });

  const issueView = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    const { positional } = yield* options(args, {});
    const issue = yield* call(
      Issue,
      "GET",
      `/issues/${yield* number(positional[0], SUPPORTED[4] ?? "")}`,
    );
    return viewText(issue, issue.state.toUpperCase(), issue.body);
  });

  const repoView = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    yield* options(args, {});
    const found = yield* call(Repo, "GET", "");
    return [
      `name:\t${found.full_name}`,
      `description:\t${found.description ?? ""}`,
      `default branch:\t${found.default_branch}`,
      `url:\t${found.html_url}`,
    ].join("\n");
  });

  const COMMANDS: Record<
    string,
    (args: ReadonlyArray<string>) => Effect.Effect<string, Usage | GitHubFailed>
  > = {
    "pr create": prCreate,
    "pr view": prView,
    "pr list": prList,
    "pr comment": prComment,
    "issue view": issueView,
    "repo view": repoView,
  };
  return COMMANDS;
};

/** Runs one gh command line against the cloned GitHub repo and returns what the model reads. */
export const gh = async (line: string, context: GhContext): Promise<string> => {
  const { clone, url, api } = context;
  const repo = url === undefined ? undefined : gitHubRepo(url);
  if (clone === undefined) return "gh is not configured: no repo is cloned. Call clone_repo first.";
  if (repo === undefined) return `gh is not configured: ${clone.repo} is not a github.com repo.`;
  if (api === undefined) return "gh is not configured: the agent has no GitHub App.";
  let argv: ReadonlyArray<string>;
  try {
    argv = parseArgv(line);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const command = make(context, repo, api, clone.branch)[argv.slice(0, 2).join(" ")];
  if (command === undefined) {
    return `gh ${line.trim()} is not supported. Supported commands:\n${SUPPORTED.join("\n")}`;
  }
  return Effect.runPromise(
    command(argv.slice(2)).pipe(
      Effect.catch((error) =>
        Effect.succeed(error._tag === "Usage" ? `gh: ${error.message}` : error.message),
      ),
    ),
  );
};
