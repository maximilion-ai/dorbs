// Registered-repo fixtures for the typecheck tests, the agent-worker tests and the e2e run.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import type * as NodeHttp from "node:http";
import * as NodePath from "node:path";

// No user or system git config, so a developer's hooks, signing or helpers never reach a fixture.
const GIT_ENV = {
  PATH: process.env["PATH"] ?? "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const git = (args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", args, { env: GIT_ENV, encoding: "utf8" }).trim();

/** A file's content, or a symlink to `symlink`. */
export type FixtureFile = string | { readonly symlink: string };

/** Commits `files` to a new bare repo at `gitDir` and returns the commit SHA. */
export const makeRepo = (gitDir: string, files: Record<string, FixtureFile>): string => {
  const work = NodeFS.mkdtempSync(`${gitDir}.work-`);
  for (const [path, file] of Object.entries(files)) {
    const target = NodePath.join(work, path);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    if (typeof file === "string") NodeFS.writeFileSync(target, file);
    else NodeFS.symlinkSync(file.symlink, target);
  }
  git(["init", "--quiet", "--bare", "--initial-branch=main", gitDir]);
  const tree = ["--git-dir", gitDir, "--work-tree", work];
  git([...tree, "add", "--all"]);
  git([
    ...tree,
    "-c",
    "user.name=dorbs",
    "-c",
    "user.email=dorbs@example.test",
    "commit",
    "--quiet",
    "--message",
    "fixture",
  ]);
  NodeFS.rmSync(work, { recursive: true, force: true });
  return git(["--git-dir", gitDir, "rev-parse", "HEAD"]);
};

const CGI_HEADER_END = Buffer.from("\r\n\r\n");

/** Answers git's smart HTTP protocol for the bare repos under `root` with `git http-backend`. */
export const serveGit =
  (root: string) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = Buffer.from(await request.arrayBuffer());
    const output = await new Promise<Buffer>((resolve, reject) => {
      const child = NodeChildProcess.spawn("git", ["http-backend"], {
        env: {
          ...GIT_ENV,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          // http-backend refuses pushes from an unauthenticated client unless receive-pack is on.
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.receivepack",
          GIT_CONFIG_VALUE_0: "true",
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          CONTENT_LENGTH: String(body.length),
          HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
          GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
        },
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.once("error", reject);
      child.once("close", () => resolve(Buffer.concat(chunks)));
      child.stdin.end(body);
    });
    const end = output.indexOf(CGI_HEADER_END);
    const headers = new Headers();
    let status = 200;
    for (const line of output.subarray(0, end).toString().split("\r\n")) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else headers.append(name, value);
    }
    return new Response(new Uint8Array(output.subarray(end + CGI_HEADER_END.length)), {
      status,
      headers,
    });
  };

/** A Node request listener that answers with a fetch-style handler, such as serveGit's. */
export const nodeListener =
  (handle: (request: Request) => Promise<Response> | Response): NodeHttp.RequestListener =>
  (request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const answer = await handle(
        new Request(`http://${request.headers.host ?? "127.0.0.1"}${request.url ?? "/"}`, {
          method: request.method ?? "GET",
          headers,
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: Buffer.concat(chunks) }),
        }),
      );
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(Buffer.from(await answer.arrayBuffer()));
    })();
  };
