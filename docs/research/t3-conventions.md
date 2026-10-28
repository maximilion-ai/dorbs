# T3 Code conventions to mirror

Source: T3 Code `main` @ 125b619 (2026-10-28). Paths relative to `/tmp/t3src/t3code`.

## 1. Layout, manifests, tsconfig

- Workspaces: `apps/*`, `packages/*`, `infra/*`, `oxlint-plugin-t3code`, `scripts` (`pnpm-workspace.yaml:1-7`). Packages are `@t3tools/<name>`, `private: true`, `type: module` (`packages/contracts/package.json:1-8`).
- Exports point at source, one subpath per module, no barrel, no build: `"./x": { "types": "./src/x.ts", "import": "./src/x.ts" }` (`packages/shared/package.json`, `AGENTS.md:188`).
- Per-package scripts: `"typecheck": "tsc --noEmit"`, `"test": "vp test run --config ../../vite.config.ts --dir ."` (`packages/effect-acp/package.json:40-44`).
- Package tsconfigs extend the base and set only `types`/`lib`/`include`. The Worker variant uses `lib: ["ES2023","WebWorker"]` and `@cloudflare/workers-types` (`infra/relay/tsconfig.json`).
- Base options (`tsconfig.base.json:2-20`): `module`/`moduleResolution: NodeNext`, `noEmit`, `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` (imports end in `.ts`), `erasableSyntaxOnly`, `verbatimModuleSyntax`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`.
- The Effect language-service plugin runs about 50 diagnostics as errors, such as `globalDate`, `globalFetch`, and `leakingRequirements` (`tsconfig.base.json:21-107`).
- Node `26.12.1`, `pnpm@12.14.0` (`package.json:67,69`).
- TypeScript is tsc-rs: `typescript: npm:@tsc-rs/typescript@0.8.0` (`pnpm-workspace.yaml:80`, `AGENTS.md:103`).
- Shared versions live in `catalog:` (`pnpm-workspace.yaml:32-95`) and are forced in `overrides` (`:319`). Consumers write `"effect": "catalog:"`.

## 2. Effect style

- Effect 4.0.5 (effect-smol): `effect`, `@effect/platform-node`, `@effect/vitest`, and `alchemy` 2.0.0-beta.84 (`pnpm-workspace.yaml:50-70`). RPC and Stdio come from `effect/rpc/*` and `effect/Stdio` (`packages/effect-acp/src/agent.ts:1-11`).
- Services use `class Foo extends Context.Service<Foo, {…interface inline…}>()("t3/area/Foo") {}`. Not `Context.Tag`, not `Effect.Service`. No `FooShape`; refer to the interface as `Foo["Service"]` (`docs/internals/effect-services.md:55-58,76`).
- Module order: one service per file, in this order: imports → errors/schemas → tag → private `make` → `export const layer = Layer.effect(Foo, make)` (`effect-services.md:40-67`). See `apps/server/src/workspace/WorkspacePaths.ts`.
- Imports are namespaces: `import * as Effect from "effect/Effect"`, never `import { Effect } from "effect"`. Consumers use `Foo.layer` (`effect-services.md:69-75`).
- Dependencies are yielded from context, never passed to `make` (`:78-81`).
- Errors are `Schema.TaggedError` with structured attributes and `cause: Schema.Defect()`. The message is a `get message()` built from attributes, never from `cause` (`effect-services.md:46-53,124-132`, `WorkspacePaths.ts:23-34`). Catch with `Effect.catchTags`, even for one tag (`:152-154`).
- Spans: reusable functions are `Effect.fn("Service.op")(function* …)`, and the name is the span. Use `fnUntraced` only for hot paths, with a comment saying why (`AGENTS.md:198-203`, `effect-services.md:95-110`).
- `runPromise` is allowed only at app boundaries (`effect-services.md:114-117`). Transports decode, call one service method, and map errors (`:15-17`).
- Tests use `import { assert, it } from "@effect/vitest"` and `it.effect(...)` (`packages/effect-acp/src/agent.test.ts:11,48`) on `TestClock`. No sleeps, polling, retries, or per-test timeouts (`AGENTS.md:112-120`).
- Alchemy Worker/DO: `class Api extends Cloudflare.Worker<Api,{}>()("Api")`, `Api.make(...)` (`infra/relay/src/worker.ts:117-119`). `class X extends Cloudflare.DurableObject<X,{…rpc}>()("X")` (`infra/relay/src/hooks/HookInboxObject.ts:20-28`). Stack: `infra/relay/alchemy.run.ts:19-30`.

## 3. Tooling

- `vp` (Vite+ 1.4.0) wraps everything: `vp lint` (oxlint), `vp fmt` (oxfmt), `vp run -r --cache typecheck` (tsc-rs per package), `vp run -r test` (vitest) (`package.json:27-43`).
- Oxlint config lives in `vite.config.ts:188-634`:
  - plugins `eslint, oxc, react, unicorn, typescript`
  - `categories: {correctness, suspicious, perf: "warn"}`
  - `no-unused-vars` with `^_` ignores (`:242-245`)
  - `typeAware: false, typeCheck: false` (`:629-633`), so T3 does not lint type-aware.
- Custom plugin: `jsPlugins: ["./oxlint-plugin-t3code/index.ts"]` (`:207`), via `definePlugin` from `@oxlint/plugins` (`oxlint-plugin-t3code/index.ts:35`); 31 rules. Rules relevant to us (`vite.config.ts:279-297`):
  `prefer-effect-fn`, `prefer-catch-tags`, `namespace-node-imports`, `no-global-process-runtime`, `no-inline-schema-compile`, `no-manual-effect-runtime-in-tests`, `no-low-value-comments`, `require-suppression-reason`, and the five test-timing rules. The rest are UI-specific.
- Format: oxfmt with `sortPackageJson` (`vite.config.ts:154-187`), run on staged files (`:151-153`).
- Knip: `rules.types: off` and `packages/*: includeEntryExports: true` (`knip.jsonc:4,139-142`). Alchemy entries: `"alchemy.run.ts!", "src/worker.ts!"` (`:137`).
- `check:changed` (`scripts/check-changed.ts:226-257`) runs these in parallel: `fmt --check` and `lint` on changed files, knip, typecheck of affected packages and their dependents, and the `*.test.ts` files next to changed files.

## 4. Style rules worth adopting

- Default to no comment. Write one only for a constraint, quirk, or invariant: one line, four at most (`AGENTS.md:205`).
- Every suppression gets `-- reason` (`effect-services.md:162-163`).
- Inferred types over annotations; `any` is the enemy (`AGENTS.md:204`).
- Test behavior that can break, such as protocol translation, parsing, and races, at the lowest layer that fails. Extend an existing case before adding an `it` (`AGENTS.md:105-107`).
- A bug fix starts with a failing test (`:111`).
- Docs hold decisions and traps, not catalogs (`AGENTS.md:161-166`).

## 5. Reusing `packages/effect-acp`

- It is not published. The manifest is `"name": "effect-acp", "private": true` (`packages/effect-acp/package.json:2-3`). `npm view @t3tools/effect-acp` returns 404.
- `npm view effect-acp` returns an unrelated package (0.1.0, `julia-script/acpclient`). Don't install by name.
- Its only runtime dependency is `effect` (`package.json:46-48`). Size: about 4.5k handwritten lines in `src/`, plus about 19.4k generated lines (`src/_generated/schema*.gen.ts`).
- The generator downloads the ACP schema from the GitHub releases of `agentclientprotocol/agent-client-protocol` (`scripts/generate.ts:95`).
- Transport is Stdio-shaped. `AcpStdio` is a `Stream<Uint8Array>` in and a `Sink` out (`src/protocol.ts:69-71`).
  - `AcpAgent.layer(stdio)` (`src/agent.ts:554`) needs no `effect/process`, so a Worker can adapt WebSocket frames into `Stdio.make(...)` (see `src/_internal/stdio.ts:24-40`).
  - `client.ts` imports `ChildProcessSpawner` (`:14`), so it is Node-only.
- To vendor it:
  1. Copy the directory to `packages/effect-acp`.
  2. Add a `LICENSE` with T3's MIT text (`LICENSE:1-3`, "Copyright (c) 2026 T3 Tools Inc.").
  3. Record upstream commit `125b619` in a README.

## 6. Adopt / adapt / skip

**Adopt:** tsconfig base and Effect LS block. Catalog + `overrides`. Source subpath exports. The service module shape. `Schema.TaggedError`. `Effect.fn` spans. `it.effect` + TestClock. Knip. `check:changed`. tsc-rs via `typescript: npm:@tsc-rs/typescript` (presumably the tsrs you mean). Alchemy Worker/DO classes.

**Adapt:**

- Move the oxlint config into a standalone `.oxlintrc.json`.
- Copy only the Effect and test rules above, with their tests, into our own `jsPlugins` package.
- Use vitest directly. Then `@effect/vitest` needs no patch; T3's patch only exists for Vite+ (`pnpm-workspace.yaml:351-353,365`).

**Skip:**

- Vite+ and oxfmt. Biome overlaps oxfmt, so use Biome to format only, with its linter off.
- React, mobile, and shadcn rules, and the remote task cache.
- Type-aware oxlint, which T3 also keeps off.
