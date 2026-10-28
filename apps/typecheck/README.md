# typecheck

One shared HTTP service that type-checks and lints agent workspaces, so each agent Durable Object does not run its own checker. Request and response shapes live in `@dorbs/protocol/typecheck`.

## API

Every route requires `Authorization: Bearer $TYPECHECK_TOKEN` and answers 401 otherwise.

- `PUT /blobs/:sha256` stores the request body under its SHA-256. A body that hashes to anything else gets 422. Repeating an upload is harmless.
- `POST /check` takes a `CheckRequest`. If the store lacks the lockfile or any file blob, the answer is `MissingBlobs` with exactly those hashes. Upload them and retry. Otherwise the answer is `CheckResult` with `tsrs` and `oxlint` diagnostics. Paths are relative to the project root.

The project must contain `tsconfig.json` at its root, and `package.json` files that match the lockfile. The first check on a lockfile runs `pnpm install --frozen-lockfile --ignore-scripts` once. Later checks on that lockfile reuse the install, also after a restart. A failed install answers 422 and is retried by the next check.

## Run locally

```sh
pnpm install
DATA_DIR=/tmp/typecheck TYPECHECK_TOKEN=dev pnpm --filter @dorbs/typecheck start
```

`PORT` defaults to 8080. `pnpm start` puts the npm `tsrs` and `oxlint` launchers on `PATH`. The service also needs `pnpm` on `PATH`.

## Test

```sh
pnpm --filter @dorbs/typecheck test
```

`src/registry.live.test.ts` installs zod from the npm registry. Set `TYPECHECK_OFFLINE=1` to skip it without network.

## Docker

Build from the repo root. The image carries pnpm and the native `tsrs` and `oxlint` binaries.

```sh
docker build -f apps/typecheck/Dockerfile -t typecheck .
docker run -p 8080:8080 -v typecheck-data:/data -e TYPECHECK_TOKEN=... typecheck
```

Keep `/data` on a volume. It holds the blobs, the installs and the pnpm store, which must share one filesystem so pnpm can hard-link.
