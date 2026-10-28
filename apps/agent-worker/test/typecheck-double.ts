// Runs in the vitest process as the Worker's outbound fetch: the typecheck service at typecheck.test
// and the registered repo test/fixture at git.test.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Action } from "@dorbs/protocol/typecheck";
import * as Schema from "effect/Schema";

import { makeRepo, serveGit } from "../../../scripts/gitFixture.ts";

const TOKEN = "typecheck-token";
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
const git = serveGit(gitRoot);

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
    log.push(`git ${url.pathname}`);
    return url.pathname === "/__commit" ? json(fixtureCommit) : git(request);
  }
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
