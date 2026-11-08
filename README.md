<img src="assets/icon.svg" width="64" height="64" alt="">

# dorbs

dorbs runs coding agents in Cloudflare Durable Objects instead of one VM or container per agent. You drive it from [T3 Code](https://t3.codes), or from any client that speaks the [Agent Client Protocol](https://agentclientprotocol.com).

A coding agent spends most of its time waiting on the model. dorbs gives each session only what it needs while it waits: a Durable Object that holds the agent loop and the session's own edits. The repository and the checks are shared:

- **Repo snapshot.** Each repo at a commit is built once into R2 (or any S3 store). Every session reads that snapshot and stores only what it changes in its Durable Object's SQLite. Git runs on the two layers, so a commit writes only changed files and a push sends only new objects.
- **Shared checker.** The agent's `check` and `test` tools send the base commit and the changed files to `dorbs-check`, a service that keeps a ready environment per repo with dependencies installed once.

Adding a session costs no checkout, no dependency install and no machine of its own.

## How it works

```
T3 Code ── nc -U <socket> ── acp-mux ── WebSocket ──▶ agent Worker
                                                       ├─ AcpSession Durable Object (one per thread)
                                                       │    agent loop (Pi or OpenCode) + SQLite overlay
                                                       ├─ RepoBase Durable Object + R2: repo snapshots
                                                       ├─ model provider (OpenRouter, OpenCode Go, ChatGPT)
                                                       └─ dorbs-check (HTTPS): lint, typecheck, test
```

| Path                     | What it is                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/agent-worker`      | The Cloudflare Worker. One `AcpSession` Durable Object per thread runs the agent loop and its tools over the layered repo.                      |
| `apps/acp-mux`           | A small Node daemon. It relays each local ACP connection to the Worker over one WebSocket. See its [README](apps/acp-mux/README.md).            |
| `crates/dorbs-check`     | The checker service in Rust. It runs checks and tests in warm, locked-down Docker environments. See its [README](crates/dorbs-check/README.md). |
| `packages/protocol`      | The ACP and checker wire types shared by the Worker, the mux and the scripts.                                                                   |
| `packages/oxlint-plugin` | Lint rules for this repo.                                                                                                                       |
| `scripts`                | The local stack, the end-to-end run and checker tools.                                                                                          |

The same Worker also runs on [celld](https://celld.dev), a self-hosted runtime for Workers and Durable Objects backed by S3.

## Requirements

- Node.js 26.12.1 and pnpm 12.15.0 (pinned in `package.json`)
- Rust 1.99.1 (pinned in `rust-toolchain.toml`), for the checker
- Docker, to run the checker
- A model credential, for example an OpenRouter API key
- A GitHub App, to clone private repos, push branches and open pull requests

## Try it locally

```sh
pnpm install
OPENROUTER_API_KEY=... pnpm live                # serves /tmp/dorbs-acp.sock until Ctrl-C
OPENROUTER_API_KEY=... pnpm live "<prompt>"     # runs one prompt and prints what T3 Code would show
```

`pnpm live` runs the Worker under `alchemy dev` on your machine. It registers a fixture repo and answers `check` and `test` with a local double. Set `LIVE_REPO=owner/name` to work on a real GitHub repo, and `CHECK_URL` and `CHECK_TOKEN` to use a real checker.

## Deploy

1. **Run the checker** on a Linux host with Docker. Build the static binary and install the systemd unit as described in [`crates/dorbs-check`](crates/dorbs-check/README.md). Register each repo the agent may check.
2. **Create a GitHub App** with Contents read and write, Pull requests read and write, Issues read and Metadata read, and no webhook. Install it only on the repos the agent may touch. Convert its private key to PKCS#8: `openssl pkcs8 -topk8 -nocrypt -in app.pem -out github-app.pkcs8.pem`.
3. **Deploy the Worker** from `apps/agent-worker` with [Alchemy](https://alchemy.run):

   ```sh
   umask 077   # Alchemy writes resolved secrets into .alchemy/state
   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
   AGENT_TOKEN="$(openssl rand -hex 32)" CHECK_URL=... CHECK_TOKEN=... \
   REPOS='[{"id":"owner/name","url":"https://github.com/owner/name.git"}]' \
   MODEL_PROVIDER=openrouter MODEL_ID=deepseek/deepseek-v4.1-flash OPENROUTER_API_KEY=... \
   GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY="$(cat github-app.pkcs8.pem)" \
   pnpm exec alchemy deploy --no-input --yes --stage <stage>
   ```

4. **Run acp-mux** on the machine that runs the T3 Code server:

   ```sh
   MUX_SOCKET_PATH=/tmp/dorbs.sock AGENT_URL=wss://<worker-host> AGENT_TOKEN=... node apps/acp-mux/src/main.ts
   ```

The [`dorbs-setup`](.claude/skills/dorbs-setup/SKILL.md) guide covers the Cloudflare token roles, the other model providers and the full list of variables.

## Connect T3 Code

Add a Local ACP provider on the machine that runs the T3 Code server. In `~/.t3/userdata/settings.json`, under `providerInstances`:

```json
"acpRegistry_local_acp": {
  "driver": "acpRegistry",
  "displayName": "dorbs",
  "enabled": true,
  "config": { "source": "local", "commandPath": "/usr/bin/nc", "commandArgs": ["-U", "/tmp/dorbs.sock"] }
}
```

T3 Code starts one `nc` per thread. Each thread gets its own WebSocket and its own Durable Object.

## Guarantees and limits

- A session pushes only to new `dorbs/*` branches it created. Pushes to base branches, force pushes, deletes, other remotes and writes under `.git` are refused.
- A thread survives idle days and restarts mid-turn. Sessions delete themselves after `SESSION_RETENTION_DAYS` idle days (7 by default).
- The checker runs each job without network, without capabilities and with a read-only root, and it never hands a secret to a container.
- Checks queue per repo. With many sessions on one checker, a check can wait for minutes; add replicas or capacity with `REPLICAS` and `RUN_SLOTS`.

## Develop

```sh
pnpm check   # format, lint, typecheck, tests, knip and the Rust checks
pnpm e2e     # the whole chain with a scripted model, on Pi and on OpenCode
```

The [`dorbs-checker`](.claude/skills/dorbs-checker/SKILL.md) guide explains how to register a repo with the checker and how to add a language toolchain.

## Contributing

dorbs doesn't accept outside pull requests for now. Bug reports and questions in issues are welcome.

## License

[MIT](LICENSE)
