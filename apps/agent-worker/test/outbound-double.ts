// Runs in the vitest process as the Worker's outbound fetch: the checker service at checker.test,
// the registered repo test/fixture at git.test, test/github at github.com, and GitHub's REST API at
// github-api.test, and OpenAI's token endpoint at auth.openai.com. The GitHub App is installed on test/github only.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { checkerDouble } from "../../../scripts/checkerDouble.ts";
import { makeRepo, serveGit } from "../../../scripts/gitFixture.ts";
import { githubDouble, makeAppKey } from "../../../scripts/githubFixture.ts";

const TOKEN = "check-token";
/** The files of test/fixture's one commit. */
const FIXTURE = {
  "package.json": '{ "name": "fixture", "private": true }\n',
  "tsconfig.json": '{ "compilerOptions": { "strict": true }, "include": ["src"] }\n',
  "src/index.ts": "export const greeting = 'hi';\n",
  "src/old.ts": "export const old = 1;\n",
};

/** The GitHub App's key pair; vitest.config.ts binds the private key. */
export const APP_KEY = makeAppKey();
type PullRequest = {
  number: number;
  title: string;
  body: string;
  state: "open";
  draft: boolean;
  merged_at: null;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
};
const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "dorbs",
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** One set of doubles, with their own repos and logs: one per vitest project, which run at once. */
export const makeOutboundDouble = () => {
  const log: string[] = [];
  const checker = checkerDouble(TOKEN, log);

  const gitRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dorbs-agent-git-"));
  process.once("exit", () => NodeFS.rmSync(gitRoot, { recursive: true, force: true }));
  const fixtureCommit = makeRepo(NodePath.join(gitRoot, "fixture.git"), FIXTURE);
  NodeFS.mkdirSync(NodePath.join(gitRoot, "test"));
  makeRepo(NodePath.join(gitRoot, "test/github.git"), FIXTURE);
  // 2,000 distinct files in 20 directories, for the workspace cost bounds in cost.test.ts.
  makeRepo(
    NodePath.join(gitRoot, "large.git"),
    Object.fromEntries(
      Array.from({ length: 2000 }, (_, at) => [
        `pkg${at % 20}/src/f${at}.ts`,
        `export const value${at} = ${at};\n${"// filler\n".repeat(200)}`,
      ]),
    ),
  );
  const git = serveGit(gitRoot);

  const github = githubDouble({
    publicKey: APP_KEY.publicKey,
    installations: { "test/github": 1 },
    gitRoot,
  });

  /** A ref of a bare repo under gitRoot: its commit and the files of its tree, or null when it is absent. */
  const readRef = (repo: string, ref: string) => {
    const run = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", ["--git-dir", NodePath.join(gitRoot, repo), ...args], {
        encoding: "utf8",
      });
    try {
      const commit = run("rev-parse", "--verify", "--quiet", ref).trim();
      const paths = run("ls-tree", "-r", "--name-only", commit).trim().split("\n");
      return {
        commit,
        files: Object.fromEntries(paths.map((path) => [path, run("show", `${commit}:${path}`)])),
      };
    } catch {
      return null;
    }
  };

  const pulls: PullRequest[] = [];
  /** Every call the GitHub API double answered, its body parsed. */
  const githubRequests: { method: string; path: string; body: unknown }[] = [];

  const githubApi = async (request: Request, url: URL): Promise<Response> => {
    if (url.pathname === "/__requests") return json(githubRequests);
    if (url.pathname === "/__tokens") return json(github.issued().map((grant) => grant.token));
    if (url.pathname === "/__lifetime") {
      github.setLifetime(Number(url.searchParams.get("seconds")));
      return json(true);
    }
    const text = await request.clone().text();
    githubRequests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      body: text === "" ? null : JSON.parse(text),
    });
    const wrong = Object.entries(GITHUB_HEADERS).find(
      ([name, value]) => request.headers.get(name) !== value,
    );
    if (wrong !== undefined) return json({ message: `Bad ${wrong[0]}` }, 401);
    const answered = await github.app(request);
    if (answered !== undefined) return answered;
    if (!github.authorizes(request, "test/github"))
      return json({ message: "Bad credentials" }, 401);
    if (url.pathname !== "/repos/test/github/pulls") return json({ message: "Not Found" }, 404);
    if (request.method === "GET") {
      const head = url.searchParams.get("head")?.replace(/^test:/u, "");
      return json(pulls.filter((pr) => head === undefined || pr.head.ref === head));
    }
    const { title, body, head, base, draft } = JSON.parse(text);
    if (pulls.some((pr) => pr.head.ref === head)) {
      return json(
        {
          message: "Validation Failed",
          errors: [
            {
              resource: "PullRequest",
              code: "custom",
              message: `A pull request already exists for test:${head}.`,
            },
          ],
        },
        422,
      );
    }
    const number = pulls.length + 1;
    const pr: PullRequest = {
      number,
      title,
      body,
      state: "open",
      draft,
      merged_at: null,
      html_url: `https://github.com/test/github/pull/${number}`,
      head: { ref: head },
      base: { ref: base },
    };
    pulls.push(pr);
    return json(pr, 201);
  };

  /** The refresh tokens OpenAI's token endpoint was sent; each refresh rotates to the next one. */
  const openaiRefreshes: string[] = [];
  const openaiToken = async (request: Request, url: URL): Promise<Response> => {
    if (url.pathname === "/__refreshes") return json(openaiRefreshes);
    const form = new URLSearchParams(await request.text());
    if (
      url.pathname !== "/api/accounts/oauth/token" ||
      form.get("grant_type") !== "refresh_token"
    ) {
      return json({ error: "unsupported" }, 400);
    }
    openaiRefreshes.push(form.get("refresh_token") ?? "");
    const n = openaiRefreshes.length;
    return json({
      access_token: `access-${n}`,
      refresh_token: `refresh-${n}`,
      scope: "openid offline_access chatgpt.tokens.use.direct",
      expires_in: 3600,
    });
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.host === "auth.openai.com") return openaiToken(request, url);
    if (url.host === "git.test") {
      log.push(
        `git ${url.pathname}${request.headers.has("authorization") ? " with credentials" : ""}`,
      );
      if (url.pathname === "/__commit") return json(fixtureCommit);
      if (url.pathname === "/__ref") {
        return json(readRef(url.searchParams.get("repo") ?? "", url.searchParams.get("ref") ?? ""));
      }
      return git(request);
    }
    // test/github is private: fetches need a token as well as pushes.
    if (url.host === "github.com") return github.git(request);
    if (url.host === "github-api.test") return githubApi(request, url);
    if (url.host !== "checker.test") {
      log.push(
        `stray ${url.host}${url.pathname}${request.headers.has("authorization") ? " with credentials" : ""}`,
      );
      return new Response("Tests have no network", { status: 502 });
    }
    return checker.handle(request);
  };
};
