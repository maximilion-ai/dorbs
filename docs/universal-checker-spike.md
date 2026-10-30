# dorbs universal checker: measurements and design (2026-10-30)

Box: devbox (Ubuntu 24.04, kernel 6.8, 10 cores, 27 GB, ext4 root without reflinks, rootless Docker 29.9).
Scripts: devbox `~/scratch/dorbs-checker/bench/` (copy in `/tmp/dorbs-checker-bench/` on the Mac mini).
Raw logs: devbox `~/scratch/dorbs-checker/logs/` (`times.log` holds every `/usr/bin/time` line; `warm-*.jsonl` and `conc-*.jsonl` hold the LSP and watch runs).
Caches started empty (`cache/` under scratch), so install times are cold-cache.

Probe edit: append one type error to one file (`export const __dorbsProbe: number = "x";`, Python `__dorbs_probe: int = "x"`, Rust `pub const __DORBS_PROBE: u32 = "x";`, Go `var dorbsProbe int = "x"`), then time until the tool reports it, then revert. Every timed run had to report the probe (`probe-hit` ≥ 1, or the LSP predicate "matching diagnostics > baseline").

Versions (retrieved today): TypeScript 7.0.2 (latest; 7.1 beta out), typescript-language-server 6.0.2 driving the repo's own tsserver, svelte-check 4.7.7, svelte-language-server 0.18.5, vue-tsc 3.3.14, pyright 1.1.414, basedpyright 1.40.2, ty 0.0.95, ruff 0.16.8, oxlint 1.90.0, Rust 1.99.1, rust-analyzer 2026-10-26, Go 1.27.3, gopls v0.24.0, uv 0.10.11, bun 1.4.4, Node 24.22.1, pnpm via corepack per `packageManager`.

## 1. Measurements

### Setup (cold cache)

| Repo                    | Manager          | Command                                                                 | Time       | Peak RSS | Note                                                                                                                                               |
| ----------------------- | ---------------- | ----------------------------------------------------------------------- | ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| vitest-dev/vitest       | pnpm 11.28.6     | `pnpm install --frozen-lockfile --ignore-scripts`                       | 24.1 s     | 1.99 GB  | 9 deps with install scripts skipped                                                                                                                |
| TanStack/router         | pnpm 11.21.0     | same                                                                    | 58.1 s     | 3.07 GB  | 17 deps with install scripts (prisma, sentry-cli, sharp, workerd…)                                                                                 |
| vbenjs/vue-vben-admin   | pnpm 11.16.0     | same                                                                    | 22.8 s     | 2.82 GB  | root postinstall `pnpm -r run --if-present stub` (4.8 s)                                                                                           |
| huntabyte/shadcn-svelte | pnpm 12.14.0     | same                                                                    | 10.2 s     | 0.92 GB  | root postinstall `pnpm build:cli && pnpm -r sync` (9.9 s) + docs `pnpm sync` (5.0 s)                                                               |
| honojs/hono             | pnpm 12.6.0      | same                                                                    | 6.3 s      | 0.66 GB  |                                                                                                                                                    |
| sveltejs/realworld      | pnpm 10.20.0     | same                                                                    | fail 0.9 s |          | committed lockfile has a duplicate key (`devalue@5.8.1`); relock hit registry 404 for `@rollup/rollup-linux-x64-gnu@4.67.2`; `--no-optional` 1.1 s |
| nestjs/nest             | npm 11           | `npm ci --ignore-scripts`                                               | fail 0.8 s |          | ERESOLVE; `--legacy-peer-deps` (from their CircleCI) 10.7 s                                                                                        |
| excalidraw/excalidraw   | yarn 1.22.22     | `yarn install --frozen-lockfile --ignore-scripts`                       | 29.6 s     | 0.55 GB  |                                                                                                                                                    |
| elysiajs/elysia         | bun 1.4.4        | `bun install --frozen-lockfile --ignore-scripts`                        | 0.43 s     | 85 MB    |                                                                                                                                                    |
| pydantic/pydantic-ai    | uv               | `uv sync --frozen --all-extras --all-packages --group lint`             | 65.9 s     | 163 MB   | 435 locked packages, 2 sdist-only (forbiddenfruit, grpclib) build on install; env 6.8 GB                                                           |
| searxng/searxng         | requirements.txt | `uv venv && uv pip install -r requirements.txt -r requirements-dev.txt` | 4.0 s      | 120 MB   |                                                                                                                                                    |
| tokio-rs/axum           | cargo            | `cargo fetch --locked`                                                  | 1.8 s      | 173 MB   | 221 crates, 15 proc-macro, 27 build.rs                                                                                                             |
| cli/cli                 | go               | `go mod download`                                                       | 5.3 s      | 37 MB    |                                                                                                                                                    |

### TypeScript (repo TS = 5.9.3 unless noted; TS7 = 7.0.2)

| Repo                                                | Full CLI                                      | CLI after edit | `--incremental` after edit | watch after edit                                   | LSP edit→diag (warm)                                                 | LSP first diag                                        | Warm RSS                                                |
| --------------------------------------------------- | --------------------------------------------- | -------------- | -------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| vitest `tsc -p tsconfig.check.json --noEmit`        | 8.84 s / TS7 2.16 s                           | 8.01 / 2.27 s  | 8.75 / 2.92 s              | 6.3–7.5 / 1.9–2.3 s                                | tsserver 482–552 ms / TS7 40–49 ms                                   | 2.1 s / 0.18 s                                        | tsserver 0.9–1.0 GB, TS7 0.22–0.36 GB, watch 1.7–3.3 GB |
| excalidraw `tsc --noEmit`                           | 10.8 s / TS7 fails (TS5102 `baseUrl` removed) | 11.6 s         | 12.8 s                     | 11.8–13.4 s                                        | tsserver 1.70–2.11 s                                                 | 2.0 s                                                 | 1.0–1.4 GB                                              |
| nest `tsc -b packages` (21 refs)                    | 6.04 s / TS7 0.95 s; no-op 0.09 / 0.05 s      | 3.85 / 0.92 s  | (build mode)               | 3.4–3.8 / 2.9–3.3 s                                | tsserver 450–490 ms                                                  | 1.8 s                                                 | 0.84–0.88 GB                                            |
| elysia `tsc -p tsconfig.json --noEmit`              | 31.8 s / TS7 31.8 s (52 errors both)          | —              | 34.5 / 30.7 s              | TS7 29–33 s (TS5.9 watch died, cause not captured) | tsserver 975–1226 ms / TS7 114–196 ms                                | 2.1 s / 0.24 s                                        | TS7 watch 6.1 GB, TS7 LSP 0.2–0.4 GB                    |
| router (TS 6.0.2 via `npm:@typescript/typescript6`) | —                                             | —              | —                          | —                                                  | tsserver: cannot start (alias ships no `tsserver.js`) / TS7 69–84 ms | TS7 0.17 s (20 diagnostics, not verified against TS6) | TS7 0.19–0.31 GB                                        |

TS7 vs repo TS on vitest: 32 vs 30 errors (TS7 adds 2× TS2882). Lint: `oxlint .` vitest 0.62 s, router 0.12 s; excalidraw `eslint` 20.0 s.

### Svelte / Vue

| Repo                                                                           | Full CLI                                                                             | CLI after edit | watch after edit                     | LSP edit→diag                                           | Note                                                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------- | ------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| shadcn-svelte docs, `svelte-check --tsconfig ./tsconfig.json --output machine` | 18.8 s, 7491 errors without repo setup; 24.6 s, **0 errors** after repo setup (15 s) | 17.6 s         | `svelte-check --watch` 9.1–10.0 s    | svelte-language-server 301–339 ms, first 7.8 s, 1.86 GB | `svelte-kit sync` loads `svelte.config.js`, which imports an unbuilt workspace package |
| realworld                                                                      | cannot run                                                                           |                |                                      |                                                         | `svelte-kit sync` imports vite → rollup native binary (optional dep missing)           |
| vben web-antd `vue-tsc --noEmit --skipLibCheck`                                | 11.8 s (0 errors, with or without stub)                                              | 11.4 s         | `vue-tsc -w` 0.60–0.74 s, 1.8–2.0 GB | not measured (Volar 3 needs tsserver hybrid mode)       |                                                                                        |

svelte-check 4.7.7 peers on TypeScript ^5 || ^6; TS 7.0 has no API, so Svelte/Vue stay on TS 6 speed until 7.1's content mappers ship in their tools.

### Python

| Repo                                                     | Checker         | Full CLI                                   | CLI after edit | watch after edit               | LSP edit→diag | LSP first / RSS      |
| -------------------------------------------------------- | --------------- | ------------------------------------------ | -------------- | ------------------------------ | ------------- | -------------------- |
| pydantic-ai (pyright strict, repo pins pyright ≥1.1.414) | pyright 1.1.414 | 228 s then V8 OOM at ~4 GB heap (exit 134) | 299 s          | `pyright --watch` 322–335 s    | 691–850 ms    | 1.8 s / 0.46–0.73 GB |
|                                                          | ty 0.0.95       | 4.7 s, **4401 diagnostics** (pyright: 38)  | 6.5 s          | `ty check --watch` 0.82–0.98 s | 37–39 ms      | 0.21 s / 0.15 GB     |
|                                                          | ruff            | 0.29 s                                     |                |                                |               |                      |
| searxng (basedpyright 1.40.2 pinned)                     | basedpyright    | 8.0 s                                      | 7.2 s          |                                | 648–868 ms    | 1.7 s / 0.43–0.59 GB |
|                                                          | ty              | 0.24 s                                     | 0.25 s         |                                | 45–47 ms      | 0.25 s / 0.10 GB     |

### Rust / Go

| Repo                                                  | Full               | No-op  | After edit      | Lint                 | Warm server                                            |
| ----------------------------------------------------- | ------------------ | ------ | --------------- | -------------------- | ------------------------------------------------------ |
| axum `cargo check --workspace --all-targets --locked` | 15.3 s (cold deps) | 0.08 s | 1.49 s          | `cargo clippy` 7.2 s | rust-analyzer native diagnostic 107–312 ms, 1.6–1.8 GB |
| cli/cli `go build ./...` / `go vet ./...`             | 13.7 s / 7.0 s     |        | 0.48 s / 0.64 s | (vet)                | gopls 2–12 ms, first 0.6–0.9 s, 0.18–1.7 GB            |

### Concurrency (one box)

10 warm language servers at once (vitest/router/elysia TS7, excalidraw/nest tsserver, pydantic-ai pyright, searxng basedpyright and ty, axum rust-analyzer, cli gopls), 10 edit+revert cycles each, serial per env, parallel across envs:

- Memory: 5.3 GB summed RSS when warm, 8.5 GB after the edits; box `used` 10.1 GB of 27.4 GB.
- Throughput: 200 cycles in 37.0 s = 5.4 cycles/s aggregate. Each env's wall time equals its own serial latency (gopls 0.2 s … excalidraw 37 s).
- Latency under load vs solo (p50): TS7 vitest 87 vs 43 ms, TS7 router 116 vs 72 ms, elysia TS7 240 vs 150 ms, rust-analyzer 198 vs 117 ms, nest tsserver 466 vs 455 ms, pyright 754 vs 712 ms, basedpyright 698 vs 694 ms, excalidraw tsserver 1.69 vs 1.75 s.
- Bottleneck: per-env serial latency of the slow servers, then memory. CPU had headroom.

N concurrent full CLI checks of vitest (CPU-bound):

| N   | TS7 wall | TS7 checks/min | TS5.9 wall | TS5.9 checks/min |
| --- | -------- | -------------- | ---------- | ---------------- |
| 1   | 2.35 s   | 25.5           | 8.56 s     | 7.0              |
| 2   | 3.12 s   | 38.5           | 13.06 s    | 9.2              |
| 5   | 6.90 s   | 43.5           | 15.29 s    | 19.6             |
| 10  | 15.88 s  | 37.8           | 29.42 s    | 20.4             |

### Isolation and overlay cost

- bubblewrap: blocked (`kernel.apparmor_restrict_unprivileged_userns = 1`; `bwrap: setting up uid map: Permission denied`; `unshare -Ur` fails too). Needs an AppArmor profile, a system-wide change.
- Rootless Docker (works today): `docker run --rm --network none node:24-slim true` 379–417 ms; `docker exec` into a warm container 35–46 ms; TS7 vitest check inside a `--read-only --network none --cap-drop ALL --pids-limit 512 --memory 4g` container 2.28–2.32 s vs host 2.23–2.28 s. Verified inside: write → `Read-only file system`, DNS → none, `CapEff: 0`.
- Overlay on ext4 (router, 12,493 tracked files): `cp -r --reflink=auto` with node_modules 17.0 s (falls back to bytes); tracked files only 0.34 s; write 5 files in place and restore them 59 ms.

## 2-4: see the chat answer.
