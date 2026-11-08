---
name: dorbs-setup
description: Set up dorbs locally or on Cloudflare and connect it to T3 Code. Use when deploying the agent Worker, running the local stack, creating the Cloudflare or GitHub credentials it needs, or pointing T3 Code's Local ACP provider at a dorbs socket.
---

# Set up dorbs

dorbs runs a coding agent in Cloudflare Durable Objects. T3 Code reaches it through one local Unix socket:

```
T3 Code (Local ACP provider) -> nc -U <socket> -> acp-mux -> agent Worker (DOs) -> model (OpenRouter)
                                                                         \-> checker (check and test)
```

Pick a mode first:

- **Local**: `pnpm live` runs the Worker under `alchemy dev` on this machine. Use it to develop and to try a prompt. Nothing deploys.
- **Cloudflare**: the Worker runs on your Cloudflare account; only acp-mux runs locally.

Both modes need the same ingredients. Keep every secret in a `0700` directory such as `~/.config/dorbs`, one file per secret, mode `0600`. Never print a secret; test for presence.

## Ingredients

| Ingredient        | What it is                                                                                                                                                                                                                                                                                                    | Needed for                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Model             | `MODEL_PROVIDER` and `MODEL_ID` plus that provider's credential; see Models below. The default is OpenRouter with `deepseek/deepseek-v4.1-flash`                                                                                                                                                              | both                      |
| `AGENT_TOKEN`     | Random bearer between acp-mux and the Worker: `openssl rand -hex 32`                                                                                                                                                                                                                                          | both                      |
| GitHub App        | Private App with Contents read/write, Pull requests read/write, Issues read, Metadata read, no webhook. Install it on each repo the agent may touch, "Only select repositories". Keep its App ID and a private key converted to PKCS#8: `openssl pkcs8 -topk8 -nocrypt -in app.pem -out github-app.pkcs8.pem` | private repos, push, `gh` |
| `REPOS`           | JSON list of repos the agent may clone: `[{"id":"owner/name","url":"https://github.com/owner/name.git"}]`                                                                                                                                                                                                     | both                      |
| Checker           | `CHECK_URL` and `CHECK_TOKEN` of a running checker (see the `dorbs-checker` skill). Locally a double stands in when unset                                                                                                                                                                                     | check and test tools      |
| Cloudflare tokens | Account API tokens on the target account, below                                                                                                                                                                                                                                                               | Cloudflare                |

A private App installs only on the account that owns it. To use repos in an organization, make the App public (Advanced settings), then install it on that organization.

## Local

```sh
OPENROUTER_API_KEY="$(cat ~/.config/dorbs/openrouter-key)" pnpm live            # serves /tmp/dorbs-acp.sock until Ctrl-C
OPENROUTER_API_KEY="$(cat ~/.config/dorbs/openrouter-key)" pnpm live "<prompt>" # one prompt, prints what T3 shows
```

- `LIVE_REPO=owner/name` registers a real GitHub repo instead of the fixture. A private one reads the App ID and key from `~/.config/dorbs/github-app-id` and `~/.config/dorbs/github-app.pkcs8.pem`.
- `CHECK_URL` and `CHECK_TOKEN` point at a real checker; unset, the local double answers.
- `HARNESS=opencode` runs sessions on OpenCode instead of Pi.
- `pnpm e2e` runs the whole chain with a scripted model for both harnesses. Run it after any change to the chain.

- `LIVE_MODEL=opencode-go:<id>` with `OPENCODE_API_KEY` runs on OpenCode Go instead of OpenRouter.

Then connect T3 Code (below) with the socket `/tmp/dorbs-acp.sock`.

## Models

| `MODEL_PROVIDER` | Credential                                                                              | Harness      |
| ---------------- | --------------------------------------------------------------------------------------- | ------------ |
| `openrouter`     | `OPENROUTER_API_KEY`                                                                    | Pi, OpenCode |
| `opencode-go`    | `OPENCODE_API_KEY` from the OpenCode Console; `MODEL_ID` such as `glm-5.3` or `kimi-k3` | Pi           |
| `chatgpt`        | Sign in with ChatGPT after deploy: `pnpm chatgpt-login`; `MODEL_ID` such as `gpt-6-sol` | Pi           |

`MODEL_PROVIDER` and `MODEL_ID` name the default model. `MODELS` lists more, as JSON: `[{"provider":"chatgpt","id":"gpt-6.1-sol"},{"provider":"opencode-go","id":"glm-5.3"}]`. T3's model picker offers them all, and each thread runs on the one it picked, switching mid-thread too. Every listed provider needs its credential at deploy. OpenCode threads offer the default only. `LIVE_PICK=<provider>:<id>` picks one in `pnpm live`.

`chatgpt` uses your ChatGPT subscription. Sign in once per Worker:

```sh
AGENT_URL=https://<worker-host> AGENT_TOKEN="$(cat ~/.config/dorbs/agent-token)" pnpm chatgpt-login
```

It opens Sign in with ChatGPT in the browser and posts the credential to the Worker's `ChatGptAccount` Durable Object, which alone keeps and refreshes it; nothing but an installation id stays on disk. Every session reads the token from that one object, so parallel sessions never race on the rotating refresh token. The plan's 5-hour and weekly limits cap how far parallel sessions go.

## Cloudflare

1. **Tokens.** Cloudflare replaced the legacy "Workers Scripts" permissions with Workers roles. Create account API tokens (Manage Account, Account API Tokens):
   - First deploy: **Workers Admin** at the Workers product scope, TTL 1 day. Creating a Worker needs Admin. Delete it after the first deploy.
   - Redeploys: **Workers Editor** at the Workers product scope. A per-Worker Editor token cannot deploy through Alchemy, because Alchemy lists the account's Durable Object namespaces on every deploy and that call needs product scope.
   - Template links fill these by permission group ID, not name: Workers Admin `98d78cd2433d4c3687191bc0244ef948`, Workers Editor `d7ba8d4dce414197a3efab21b2f87eb8`, as `https://dash.cloudflare.com/?to=/<account-id>/api-tokens&permissionGroupKeys=[{"key":"<id>","type":"edit"}]` (URL-encoded).
2. **Deploy** from `apps/agent-worker`, with a private umask because Alchemy writes resolved secrets into `.alchemy/state`:

   ```sh
   umask 077
   D=~/.config/dorbs
   CLOUDFLARE_API_TOKEN="$(cat $D/cf-token)" CLOUDFLARE_ACCOUNT_ID=<account-id> \
   AGENT_TOKEN="$(cat $D/agent-token)" CHECK_URL="$(cat $D/check-url)" CHECK_TOKEN="$(cat $D/check-token)" \
   REPOS="$(cat $D/repos.json)" MODEL_PROVIDER=openrouter MODEL_ID=deepseek/deepseek-v4.1-flash \
   OPENROUTER_API_KEY="$(cat $D/openrouter-key)" \
   GITHUB_APP_ID="$(cat $D/github-app-id)" GITHUB_APP_PRIVATE_KEY="$(cat $D/github-app.pkcs8.pem)" \
   pnpm exec alchemy deploy --no-input --yes --stage <stage>
   ```

   For another model, swap `MODEL_PROVIDER`, `MODEL_ID` and the key (see Models). It prints the Worker URL. Optional vars: `HARNESS` (`pi` default, `opencode` needs the Workers paid plan for its bundle size), `SESSION_RETENTION_DAYS` (7), `GITHUB_API_URL`.

3. **Run acp-mux** on the machine that runs the T3 Code server:

   ```sh
   MUX_SOCKET_PATH=/tmp/dorbs-cloud.sock AGENT_URL=wss://<worker-host> AGENT_TOKEN="$(cat ~/.config/dorbs/agent-token)" \
     node apps/acp-mux/src/main.ts
   ```

4. **Smoke test** before touching T3: a prompt through `nc -U /tmp/dorbs-cloud.sock` must end with `stopReason: end_turn` (`scripts/stack.ts` has `acpClient` and `T3_INITIALIZE_LINE`). The Worker URL without a token must answer 401.

## Connect T3 Code

T3 Code spawns the provider command itself, without a shell, on the machine that runs the **T3 server**, not necessarily the machine whose UI you use. Configure it there.

In that machine's `~/.t3/userdata/settings.json`, under `providerInstances`, the Local ACP provider is:

```json
"acpRegistry_local_acp": {
  "driver": "acpRegistry",
  "displayName": "dorbs",
  "enabled": true,
  "config": { "source": "local", "commandPath": "/usr/bin/nc", "commandArgs": ["-U", "/tmp/dorbs-cloud.sock"] }
}
```

- Each argument is its own array element. `"-U /tmp/dorbs-cloud.sock"` as one string, or a trailing space in `commandPath`, leaves the provider yellow.
- Back the file up before editing. Adding the provider through T3's settings UI writes the same block.
- The model picker shows the Worker's `MODEL_ID`.
- A new thread with this provider must answer a short prompt. Then try a real task: clone a registered repo, edit, `check`, `test`, commit, push to a `dorbs/` branch, `gh pr create`.

## Guarantees and limits worth knowing

- Pushes go only to new `dorbs/*` branches the session created; base branches, force pushes, deletes and other remotes are refused. Writes under `.git` are refused.
- A thread survives idle days and restarts mid-turn; sessions delete themselves after `SESSION_RETENTION_DAYS` idle days.
- acp-mux and a quick tunnel to the checker are plain processes; put them under launchd or systemd for anything that must survive a reboot. A Cloudflare quick tunnel gets a new URL on every start, which means a redeploy with the new `CHECK_URL`; use a named tunnel for anything long-lived.
