import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { GITHUB_APP_ID, githubDouble, makeAppKey } from "../../../scripts/githubFixture.ts";
import { installationTokens, type CachedToken, type TokenCache } from "./githubApp.ts";

const KEY = makeAppKey();
const REPO = { owner: "test", name: "github" };

/** An App whose API calls reach a fresh GitHub double, and the double. */
const withGitHub = <A, E>(
  use: (
    app: Parameters<typeof installationTokens>[0],
    github: ReturnType<typeof githubDouble>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const gitRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dorbs-github-app-"));
      const github = githubDouble({
        publicKey: KEY.publicKey,
        installations: { "test/github": 1 },
        gitRoot,
      });
      const fetch = globalThis.fetch;
      globalThis.fetch = async (input, init) =>
        (await github.app(new Request(input, init))) ?? new Response("Not Found", { status: 404 });
      return { gitRoot, github, fetch };
    }),
    ({ github }) =>
      use(
        {
          id: GITHUB_APP_ID,
          privateKey: Redacted.make(KEY.privateKey),
          apiUrl: "http://github-api.test",
        },
        github,
      ),
    ({ gitRoot, fetch }) =>
      Effect.sync(() => {
        globalThis.fetch = fetch;
        NodeFS.rmSync(gitRoot, { recursive: true, force: true });
      }),
  );

it.live("reuses a token another minter left in the cache they share", () =>
  withGitHub((app, github) =>
    Effect.gen(function* () {
      const stored = new Map<string, CachedToken>();
      // Plain values only, as Durable Object storage keeps them.
      const cache: TokenCache = {
        get: async (key) => structuredClone(stored.get(key)),
        set: async (key, entry) => void stored.set(key, structuredClone(entry)),
      };
      const first = yield* (yield* installationTokens(app, { contents: "read" }, cache))(REPO);
      // A Durable Object evicted and made again builds its minter anew.
      const again = yield* (yield* installationTokens(app, { contents: "read" }, cache))(REPO);
      const wider = yield* (yield* installationTokens(app, { contents: "write" }, cache))(REPO);
      assert.strictEqual(Redacted.value(again), Redacted.value(first));
      assert.notStrictEqual(Redacted.value(wider), Redacted.value(first));
      assert.deepStrictEqual(
        github.issued().map((grant) => grant.permissions),
        [{ contents: "read" }, { contents: "write" }],
      );
    }),
  ),
);

it.live("mints once for calls that ask at the same time", () =>
  withGitHub((app, github) =>
    Effect.gen(function* () {
      const token = yield* installationTokens(app, { contents: "read" });
      const tokens = yield* Effect.all([token(REPO), token(REPO), token(REPO)], {
        concurrency: "unbounded",
      });
      assert.strictEqual(new Set(tokens.map(Redacted.value)).size, 1);
      assert.strictEqual(github.issued().length, 1);
    }),
  ),
);
