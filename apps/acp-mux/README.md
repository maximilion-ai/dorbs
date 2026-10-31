# acp-mux

A Node daemon that relays T3 Code's Local ACP command to the agent Worker. It never parses ACP.

Each connection to the unix socket gets a random connection id and one WebSocket to `${AGENT_URL}/acp?connection=<id>`, sent with `Authorization: Bearer ${AGENT_TOKEN}`. Each line from the socket becomes one WebSocket text message. Each WebSocket message goes back to the socket with a trailing newline. When either side closes, the mux closes the other.

## Run it

```sh
MUX_SOCKET_PATH=$HOME/.t3/acp-mux.sock \
AGENT_URL=ws://127.0.0.1:8787 \
AGENT_TOKEN=... \
pnpm --filter @dorbs/acp-mux start
```

| Variable          | Meaning                                             |
| ----------------- | --------------------------------------------------- |
| `MUX_SOCKET_PATH` | Unix socket to listen on.                           |
| `AGENT_URL`       | Base URL of the agent Worker, `ws://` or `wss://`.  |
| `AGENT_TOKEN`     | Bearer token for the Worker. The mux never logs it. |

At start the mux removes a stale socket file. It refuses to start if another mux is listening on the path, or if the path is not a socket. SIGINT or SIGTERM closes every connection and removes the socket file.

## Register it in T3 Code

1. Start the mux.
2. Open **Settings → Providers → Local ACP command**.
3. Set the command to `/usr/bin/nc -U <MUX_SOCKET_PATH>`, with the path written out, for example `/usr/bin/nc -U /Users/you/.t3/acp-mux.sock`.

T3 Code starts one `nc` per thread, and each `nc` gets its own WebSocket and Durable Object.
