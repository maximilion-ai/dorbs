import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { build, type Plugin } from "esbuild";
import { defineConfig } from "vite-plus";

import { GITHUB_APP_ID } from "../../scripts/githubFixture.ts";
import { APP_KEY, makeOutboundDouble } from "./test/outbound-double.ts";

/** Bundled CommonJS `require`s Node built-ins; ESM imports them, as wrangler's nodejs_compat bundling does. */
const builtins: Plugin = {
  name: "node-builtins",
  setup(build) {
    build.onResolve({ filter: /.*/ }, ({ path, kind }) => {
      if (!NodeModule.isBuiltin(path)) return undefined;
      const name = path.startsWith("node:") ? path : `node:${path}`;
      return kind === "require-call"
        ? { path: name, namespace: "node-builtin" }
        : { path: name, external: true };
    });
    build.onLoad({ filter: /.*/, namespace: "node-builtin" }, ({ path }) => ({
      contents: `import builtin from ${JSON.stringify(path)}; module.exports = builtin;`,
    }));
  },
};

/**
 * OpenCode's workerd build, bundled once per version the way the Worker bundler bundles it, for
 * test/opencode-native.ts to import natively.
 */
const openCodeBundle = async (): Promise<string> => {
  const sdk = NodePath.dirname(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.resolve("@opencode/sdk/workerd"))),
  );
  const { version } = JSON.parse(NodeFS.readFileSync(NodePath.join(sdk, "package.json"), "utf8"));
  const outfile = NodePath.join(
    import.meta.dirname,
    `node_modules/.cache/dorbs/opencode-${version}.mjs`,
  );
  if (NodeFS.existsSync(outfile)) return outfile;
  await build({
    entryPoints: [NodePath.join(sdk, "dist/workerd.js")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "module", "browser"],
    mainFields: ["browser", "module", "main"],
    external: ["cloudflare:*", "bun:*"],
    plugins: [builtins],
    // As wrangler defines them for CommonJS in a Worker.
    define: { __dirname: '"/"', __filename: '"/index.js"' },
    logLevel: "error",
  });
  return outfile;
};

const harness = (name: string, loop: "pi" | "opencode", include: ReadonlyArray<string>) => ({
  extends: true,
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          AcpConnection: { className: "AcpConnection", useSQLite: true },
          AcpSession: { className: "AcpSession", useSQLite: true },
          GitHubTokens: { className: "GitHubTokens", useSQLite: true },
          ChatGptAccount: { className: "ChatGptAccount", useSQLite: true },
        },
        bindings: {
          AGENT_TOKEN: "agent-token",
          CHECK_URL: "http://checker.test",
          CHECK_TOKEN: "check-token",
          REPOS: JSON.stringify([
            { id: "test/fixture", url: "http://git.test/fixture.git" },
            { id: "test/github", url: "https://github.com/test/github.git" },
            { id: "test/elsewhere", url: "https://github.com/test/elsewhere.git" },
          ]),
          GITHUB_APP_ID,
          GITHUB_APP_PRIVATE_KEY: APP_KEY.privateKey,
          GITHUB_API_URL: "http://github-api.test",
          HARNESS: loop,
          MODEL_PROVIDER: "scripted",
          MODEL_ID: "scripted",
          ALCHEMY_DEV: "true",
        },
        outboundService: makeOutboundDouble(),
      },
    }),
  ],
  // A first prompt loads the tools' modules over the runner's connection; beside `pnpm rust` that passes the 10 s default.
  test: { name, include: [...include], hookTimeout: 30_000 },
});

export default defineConfig({
  define: { __OPENCODE_BUNDLE__: JSON.stringify(await openCodeBundle()) },
  resolve: {
    alias: {
      "@opencode/sdk/workerd": NodePath.join(import.meta.dirname, "test/opencode-native.ts"),
    },
    // One copy of each Pi package, so the harness and the faux provider share module state.
    dedupe: ["@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-durable"],
  },
  test: {
    // Each project has its own doubles, whose request log and held check its tests assert on.
    projects: [
      harness("pi", "pi", ["src/**/*.test.ts", "test/acp.test.ts"]),
      // The ACP behaviours again with OpenCode as the agent loop, then what only OpenCode has to show.
      harness("opencode", "opencode", ["test/acp.test.ts"]),
      // Minting under both loops, apart from the suites above, whose tokens sessions share.
      harness("pi-tokens", "pi", ["test/tokens.test.ts"]),
      harness("opencode-tokens", "opencode", ["test/tokens.test.ts"]),
      harness("opencode-only", "opencode", ["test/opencode.test.ts"]),
      // Restarts under both loops, apart from the suites above, whose held check they would release.
      harness("pi-restart", "pi", ["test/restart.test.ts"]),
      harness("opencode-restart", "opencode", ["test/restart.test.ts"]),
    ],
  },
});
