// The test pool's stand-in for @opencode/sdk/workerd. Vite's module runner cannot evaluate OpenCode (workerd exits
// while loading it), so vitest.config.ts prebundles it as the Worker bundler would, and this imports that bundle
// through workerd's own module loader instead.
import type * as Sdk from "@opencode/sdk/workerd";

declare const __OPENCODE_BUNDLE__: string;

// oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-type-assertion -- an import Vite cannot rewrite, typed as the module it loads
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<typeof Sdk>;

export const OpenCodeWorkerd: typeof Sdk.OpenCodeWorkerd = {
  create: async (options: Sdk.OpenCodeWorkerd.CreateOptions) =>
    (await nativeImport(__OPENCODE_BUNDLE__)).OpenCodeWorkerd.create(options),
};
