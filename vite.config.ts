import { defineConfig } from "vite-plus";

const IGNORED = ["node_modules", "dist", ".wrangler", ".alchemy", ".vite-plus", "pnpm-lock.yaml"];

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**"],
    allowOnly: false,
    // Flaky tests are fixed, not retried.
    retry: 0,
  },
  fmt: {
    ignorePatterns: [...IGNORED, "docs/decisions.tsv"],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: IGNORED,
    plugins: ["eslint", "oxc", "unicorn", "typescript"],
    jsPlugins: ["./packages/oxlint-plugin/index.ts"],
    categories: {
      correctness: "error",
      suspicious: "error",
    },
    rules: {
      "eslint/no-control-regex": "off",
      "eslint/no-shadow": "off",
      "eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "typescript/no-extraneous-class": "error",
      "typescript/no-this-alias": "off",
      "unicorn/consistent-function-scoping": "off",
      "dorbs/namespace-node-imports": "error",
      "dorbs/no-inline-schema-compile": "error",
      "dorbs/no-low-value-comments": "error",
      "dorbs/no-manual-effect-runtime-in-tests": "error",
      "dorbs/no-polling-loop-in-tests": "error",
      "dorbs/no-real-time-wait-in-tests": "error",
      "dorbs/no-test-in-loop": "error",
      "dorbs/no-test-timeout-or-unreasoned-skip": "error",
      "dorbs/no-wall-clock-in-tests": "error",
      "dorbs/prefer-catch-tags": "error",
      "dorbs/prefer-effect-fn": "error",
      "dorbs/require-suppression-reason": "error",
    },
    options: {
      reportUnusedDisableDirectives: "error",
      typeAware: true,
    },
  },
});
