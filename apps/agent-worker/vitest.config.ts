import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

import { GITHUB_APP_ID } from "../../scripts/githubFixture.ts";
import { APP_KEY, typecheckDouble } from "./test/typecheck-double.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          AcpConnection: { className: "AcpConnection", useSQLite: true },
          AcpSession: { className: "AcpSession", useSQLite: true },
        },
        bindings: {
          AGENT_TOKEN: "agent-token",
          TYPECHECK_URL: "http://typecheck.test",
          TYPECHECK_TOKEN: "typecheck-token",
          REPOS: JSON.stringify([
            { id: "test/fixture", url: "http://git.test/fixture.git" },
            { id: "test/github", url: "https://github.com/test/github.git" },
            { id: "test/elsewhere", url: "https://github.com/test/elsewhere.git" },
          ]),
          GITHUB_APP_ID,
          GITHUB_APP_PRIVATE_KEY: APP_KEY.privateKey,
          GITHUB_API_URL: "http://github-api.test",
          MODEL_PROVIDER: "scripted",
          MODEL_ID: "scripted",
          ALCHEMY_DEV: "true",
        },
        outboundService: typecheckDouble,
      },
    }),
  ],
  // One copy of each Pi package, so the harness and the faux provider share module state.
  resolve: {
    dedupe: ["@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-durable"],
  },
  test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"] },
});
