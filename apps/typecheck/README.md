# typecheck

One shared HTTP service that type-checks and lints agent workspaces, so each agent Durable Object does not run its own checker. Request and response shapes live in `@dorbs/protocol/typecheck`.

## API

Every route requires `Authorization: Bearer $TYPECHECK_TOKEN` and answers 401 otherwise.

- `PUT /blobs/:sha256` stores the request body under its SHA-256. A body that hashes to anything else gets 422. Repeating an upload is harmless.
- `POST /actions` takes an `Action`: a kind (`check` is the only one), a toolchain, a registered repo, a commit, the files that differ from that commit, and the files deleted from it. The answer is one of these:
  - `Rejected` with `UnknownToolchain`, `UnknownRepo` or `ProtectedPaths`, before any work. Protected paths are dependency and tool config (`isProtectedPath` in `@dorbs/protocol/typecheck`). Push such changes to the repo first.
  - `ActionResult` with `cached: true` when an identical action ran before. No tool runs.
  - `MissingBlobs` with exactly the file hashes the store lacks. Upload them and retry.
  - `Rejected` with `UnknownCommit` when the repo has no such commit, or `ProtectedPaths` for a file the commit's `tsconfig.json` extends or references.
  - `ActionResult` with diagnostics from the toolchain's tools, and `outputs`, which a check leaves empty. Paths are relative to the repo root.

The service runs one toolchain, `node26-tsrs0.20-oxlint1.89`. It caches each `ActionResult` on disk under the SHA-256 of the action, with files and deletions sorted, so the cache holds across restarts and every client shares it.

## Repos

`REPOS_FILE` names a JSON file that registers the repos the service checks:

```json
[
  {
    "id": "maximilion/dorbs",
    "url": "https://git.example.com/maximilion/dorbs.git",
    "tokenEnv": "DORBS_READ_TOKEN"
  }
]
```

The service reads the file once at startup. `tokenEnv` is optional and names the environment variable that holds a read token. A github.com repo without `tokenEnv` gets a read token from the GitHub App instead, when `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM) are set: the service mints an installation token with `contents: read` for that repo alone, and reuses it until five minutes before it expires. `GITHUB_API_URL` defaults to `https://api.github.com`. git sends the token as an `Authorization` header and never puts it on a command line.

An action fetches its commit with `git fetch --depth 1` into a bare cache per repo, then lays a clean tree of the commit on disk. Every check of that commit shares the tree. A check copies the tree, applies the change, links `node_modules`, and runs the tools. Config, manifests and the lockfile always come from the commit, so trust equals write access to the repo, as in CI. oxlint runs with the service's own config, never the repo's.

Dependencies install once per lockfile hash (`pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`) from the commit's manifests, `pnpm-lock.yaml` and `pnpm-workspace.yaml`. The commit's `.npmrc` does not apply. A committed symlink becomes a plain file in the tree, so no client write can leave its check. Every check on that lockfile shares the install, also after a restart. A failed install answers 422 and is retried by the next check. A failed fetch answers 502.

## Run locally

```sh
pnpm install
DATA_DIR=/tmp/typecheck REPOS_FILE=repos.json TYPECHECK_TOKEN=dev pnpm --filter @dorbs/typecheck start
```

`PORT` defaults to 8080. `HOST` defaults to `127.0.0.1`, so only this machine reaches the service; the Docker image sets `0.0.0.0`. `pnpm start` puts the npm `tsrs` and `oxlint` launchers on `PATH`. The service also needs `pnpm` and `git` on `PATH`.

## Test

```sh
pnpm --filter @dorbs/typecheck test
```

`src/registry.live.test.ts` installs zod from the npm registry. Set `TYPECHECK_OFFLINE=1` to skip it without network.

## Docker

Build from the repo root. The image carries git, pnpm and the native `tsrs` and `oxlint` binaries.

```sh
docker build -f apps/typecheck/Dockerfile -t typecheck .
docker run -p 8080:8080 -v typecheck-data:/data -v ./repos.json:/repos.json -e REPOS_FILE=/repos.json -e TYPECHECK_TOKEN=... typecheck
```

Keep `/data` on a volume. It holds the blobs, the action cache, the git caches, the checkouts, the installs and the pnpm store, which must share one filesystem so pnpm can hard-link.
