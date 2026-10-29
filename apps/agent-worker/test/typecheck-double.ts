// Runs in the vitest process as the Worker's outbound fetch: the typecheck service at typecheck.test,
// the registered repo test/fixture at git.test, test/github at github.com, and GitHub's REST API at
// github-api.test.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Action } from "@dorbs/protocol/typecheck";
import * as Schema from "effect/Schema";

import { makeRepo, serveGit } from "../../../scripts/gitFixture.ts";

const TOKEN = "typecheck-token";
const GITHUB_TOKEN = "github-token";
const decodeAction = Schema.decodeUnknownSync(Schema.fromJsonString(Action));
const blobs = new Map<string, string>();
const log: string[] = [];
const actions: Action[] = [];
/** While set, POST /actions waits until GET /__release. */
let held: PromiseWithResolvers<void> | undefined;

/** The files of test/fixture's one commit. */
const FIXTURE = {
  "package.json": '{ "name": "fixture", "private": true }\n',
  "tsconfig.json": '{ "compilerOptions": { "strict": true }, "include": ["src"] }\n',
  "src/index.ts": "export const greeting = 'hi';\n",
  "src/old.ts": "export const old = 1;\n",
};

const gitRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dorbs-agent-git-"));
process.once("exit", () => NodeFS.rmSync(gitRoot, { recursive: true, force: true }));
const fixtureCommit = makeRepo(NodePath.join(gitRoot, "fixture.git"), FIXTURE);
NodeFS.mkdirSync(NodePath.join(gitRoot, "test"));
makeRepo(NodePath.join(gitRoot, "test/github.git"), FIXTURE);
const git = serveGit(gitRoot);

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

const basic = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

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
const pulls: PullRequest[] = [];
/** Every call the GitHub API double answered, its body parsed. */
const githubRequests: { method: string; path: string; body: unknown }[] = [];

const GITHUB_HEADERS = {
  authorization: `Bearer ${GITHUB_TOKEN}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "dorbs",
};

const githubApi = async (request: Request, url: URL): Promise<Response> => {
  if (url.pathname === "/__requests") return json(githubRequests);
  const text = await request.text();
  githubRequests.push({
    method: request.method,
    path: `${url.pathname}${url.search}`,
    body: text === "" ? null : JSON.parse(text),
  });
  const wrong = Object.entries(GITHUB_HEADERS).find(
    ([name, value]) => request.headers.get(name) !== value,
  );
  if (wrong !== undefined) return json({ message: `Bad ${wrong[0]}` }, 401);
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

const sha256 = async (text: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

// Plants TS2322 wherever a number is initialised with a string literal.
const diagnose = (path: string, content: string) =>
  content.split("\n").flatMap((line, index) => {
    const declared = /(\w+): number = "/.exec(line);
    return declared === null
      ? []
      : [
          {
            tool: "tsrs",
            path,
            line: index + 1,
            column: declared.index + 1,
            code: "TS2322",
            message: "Type 'string' is not assignable to type 'number'.",
            severity: "error",
          },
        ];
  });

export const typecheckDouble = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
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
  if (url.host === "github.com") {
    const pushing =
      url.pathname.endsWith("/git-receive-pack") ||
      url.searchParams.get("service") === "git-receive-pack";
    if (pushing && request.headers.get("authorization") !== basic("x-access-token", GITHUB_TOKEN)) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="GitHub"' },
      });
    }
    return git(request);
  }
  if (url.host === "github-api.test") return githubApi(request, url);
  if (url.host !== "typecheck.test") return new Response("Tests have no network", { status: 502 });
  if (url.pathname === "/__log") return json(log);
  if (url.pathname === "/__actions") return json(actions);
  if (url.pathname === "/__hold") {
    held = Promise.withResolvers();
    return json(true);
  }
  if (url.pathname === "/__release") {
    held?.resolve();
    held = undefined;
    return json(true);
  }
  if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  log.push(`${request.method} ${url.pathname}`);
  const blob = /^\/blobs\/([0-9a-f]{64})$/.exec(url.pathname)?.[1];
  if (request.method === "PUT" && blob !== undefined) {
    const body = await request.text();
    if ((await sha256(body)) !== blob) return new Response("Hash mismatch", { status: 400 });
    blobs.set(blob, body);
    return new Response(null, { status: 204 });
  }
  if (request.method === "POST" && url.pathname === "/actions") {
    await held?.promise;
    const action = decodeAction(await request.text());
    actions.push(action);
    const missing = [...new Set(action.files.map((file) => file.sha256))].filter(
      (sha) => !blobs.has(sha),
    );
    if (missing.length > 0) return json({ _tag: "MissingBlobs", sha256s: missing });
    return json({
      _tag: "ActionResult",
      diagnostics: action.files.flatMap((file) =>
        diagnose(file.path, blobs.get(file.sha256) ?? ""),
      ),
      outputs: [],
      durationMs: 1,
      cached: false,
    });
  }
  return new Response("Not found", { status: 404 });
};
