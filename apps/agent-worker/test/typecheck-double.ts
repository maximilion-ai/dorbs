// Runs in the vitest process as the Worker's outbound fetch, standing in for the typecheck service.

import { CheckRequest } from "@dorbs/protocol/typecheck";
import * as Schema from "effect/Schema";

const TOKEN = "typecheck-token";
const decodeCheckRequest = Schema.decodeUnknownSync(Schema.fromJsonString(CheckRequest));
const blobs = new Map<string, string>();
const log: string[] = [];

type Request = { url: string; method: string; headers: Headers; text(): Promise<string> };

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
  if (url.host !== "typecheck.test") return new Response("Tests have no network", { status: 502 });
  if (url.pathname === "/__log") return json(log);
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
  if (request.method === "POST" && url.pathname === "/check") {
    const check = decodeCheckRequest(await request.text());
    const wanted = [check.lockfile, ...check.files.map((file) => file.sha256)];
    const missing = [...new Set(wanted.filter((sha) => !blobs.has(sha)))];
    if (missing.length > 0) return json({ _tag: "MissingBlobs", sha256s: missing });
    return json({
      _tag: "CheckResult",
      diagnostics: check.files.flatMap((file) => diagnose(file.path, blobs.get(file.sha256) ?? "")),
      durationMs: 1,
    });
  }
  return new Response("Not found", { status: 404 });
};
