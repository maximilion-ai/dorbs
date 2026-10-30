// github.com and its API as a GitHub App meets them, for the agent-worker and typecheck tests: App
// endpoints that verify the App's JWT, installation tokens narrowed to repos, and private git over
// HTTP that takes only a token issued for its repo and not yet expired.

import * as NodeCrypto from "node:crypto";

import { serveGit } from "./gitFixture.ts";

export const GITHUB_APP_ID = "4242";

/** A fresh App key pair; the private key is PKCS#8 PEM, as the agent reads it. */
export const makeAppKey = () =>
  NodeCrypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

/** A token the double issued: what the App asked for in its request body, and when it expires. */
export type Issued = {
  readonly token: string;
  readonly installation: number;
  readonly repositories: ReadonlyArray<string>;
  readonly permissions: unknown;
  readonly expiresAt: number;
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const segment = (part: string | undefined) =>
  JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));

/**
 * The double for an App with `publicKey`, installed on `installations` (repo `owner/name` to
 * installation id), serving the bare repos under `gitRoot` at `<owner>/<name>.git`.
 */
export const githubDouble = (options: {
  readonly publicKey: string;
  readonly installations: Readonly<Record<string, number>>;
  readonly gitRoot: string;
}) => {
  const issued: Issued[] = [];
  let lifetimeSeconds = 3600;
  const git = serveGit(options.gitRoot);

  // GitHub takes RS256, its App id as iss, and at most ten minutes between iat and exp.
  const appAuthorized = (request: Request): boolean => {
    const [header, payload, signature] = (request.headers.get("authorization") ?? "")
      .replace(/^Bearer /u, "")
      .split(".");
    try {
      const signed = NodeCrypto.verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        options.publicKey,
        Buffer.from(signature ?? "", "base64url"),
      );
      const { alg } = segment(header);
      const { iss, iat, exp } = segment(payload);
      const now = Date.now() / 1000;
      return signed && alg === "RS256" && iss === GITHUB_APP_ID && iat <= now && exp > now;
    } catch {
      return false;
    }
  };

  /** Whether the request carries a live token for `repo`: Bearer for the API, Basic for git. */
  const authorizes = (request: Request, repo: string): boolean => {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Basic ")
      ? /^x-access-token:(.*)$/su.exec(Buffer.from(header.slice(6), "base64").toString())?.[1]
      : header.replace(/^Bearer /u, "");
    return issued.some(
      (grant) =>
        grant.token === token &&
        grant.expiresAt > Date.now() &&
        grant.installation === options.installations[repo] &&
        grant.repositories.includes(repo.split("/")[1] ?? ""),
    );
  };

  /** Answers GitHub's App endpoints, or undefined for any other request. */
  const app = async (request: Request): Promise<Response | undefined> => {
    const { pathname } = new URL(request.url);
    const installationOf = /^\/repos\/([^/]+\/[^/]+)\/installation$/u.exec(pathname)?.[1];
    const tokensOf = /^\/app\/installations\/(\d+)\/access_tokens$/u.exec(pathname)?.[1];
    if (installationOf === undefined && tokensOf === undefined) return undefined;
    if (!appAuthorized(request)) {
      return json({ message: "A JSON web token could not be decoded" }, 401);
    }
    if (installationOf !== undefined) {
      const id = options.installations[installationOf];
      return id === undefined ? json({ message: "Not Found" }, 404) : json({ id });
    }
    const installation = Number(tokensOf);
    const owned = Object.entries(options.installations)
      .filter(([, id]) => id === installation)
      .map(([repo]) => repo.split("/")[1]);
    const { repositories = [], permissions }: { repositories?: string[]; permissions?: unknown } =
      JSON.parse(await request.text());
    if (!repositories.every((name) => owned.includes(name))) {
      return json({ message: "There is at least one repository that is not accessible." }, 422);
    }
    const grant: Issued = {
      token: `ghs_${NodeCrypto.randomBytes(18).toString("hex")}`,
      installation,
      repositories,
      permissions,
      expiresAt: Date.now() + lifetimeSeconds * 1000,
    };
    issued.push(grant);
    return json(
      {
        token: grant.token,
        expires_at: new Date(grant.expiresAt).toISOString(),
        permissions,
        repository_selection: "selected",
      },
      201,
    );
  };

  /** github.com's git over HTTP, where every repo is private. */
  const gitHost = (request: Request): Promise<Response> | Response => {
    const repo = /^\/([^/]+\/[^/]+?)\.git\//u.exec(new URL(request.url).pathname)?.[1];
    if (repo === undefined || !authorizes(request, repo)) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="GitHub"' },
      });
    }
    return git(request);
  };

  return {
    app,
    git: gitHost,
    authorizes,
    issued: (): ReadonlyArray<Issued> => issued,
    /** How long tokens issued from now on live. */
    setLifetime: (seconds: number) => {
      lifetimeSeconds = seconds;
    },
  };
};
