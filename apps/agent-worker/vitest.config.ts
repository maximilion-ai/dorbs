import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

import { typecheckDouble } from "./test/typecheck-double.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { AcpConnection: { className: "AcpConnection", useSQLite: true } },
        bindings: {
          AGENT_TOKEN: "agent-token",
          TYPECHECK_URL: "http://typecheck.test",
          TYPECHECK_TOKEN: "typecheck-token",
          MODEL_PROVIDER: "openrouter",
          MODEL_ID: "unused-in-tests",
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
