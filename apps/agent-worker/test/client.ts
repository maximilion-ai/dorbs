import { exports } from "cloudflare:workers";

const CWD = "/Users/max/project";

export type Frame = {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: any;
  readonly result?: any;
  readonly error?: { readonly code: number; readonly message: string };
};

export const open = (path: string, headers: Record<string, string>) =>
  exports.default.fetch(new Request(`http://agent.test${path}`, { headers }));

/** An ACP client on a real WebSocket to the Worker, as acp-mux holds one. */
export const connect = async (connection: string = crypto.randomUUID()) => {
  const response = await open(`/acp?connection=${connection}`, {
    Upgrade: "websocket",
    Authorization: "Bearer agent-token",
  });
  const ws = response.webSocket;
  if (ws === null) throw new Error(`Expected a WebSocket, got ${response.status}`);
  ws.accept();
  const messages: string[] = [];
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
  ws.addEventListener("message", (event) => {
    messages.push(String(event.data));
    frames.push(JSON.parse(String(event.data)));
    for (const wake of waiters) wake();
  });

  const until = (match: (frame: Frame) => boolean): Promise<Frame> =>
    new Promise((resolve) => {
      const check = () => {
        const found = frames.find(match);
        if (found === undefined) return;
        waiters.delete(check);
        resolve(found);
      };
      waiters.add(check);
      check();
    });

  const sendLine = (line: string) => ws.send(line);
  const send = (frame: Omit<Frame, "jsonrpc">) =>
    sendLine(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  const request = (id: number, method: string, params: unknown) => {
    send({ id, method, params });
    return until((frame) => frame.id === id && frame.method === undefined);
  };
  const newSession = async (): Promise<string> => {
    const { result } = await request(1, "session/new", { cwd: CWD, mcpServers: [] });
    if (typeof result?.sessionId !== "string") throw new Error("session/new returned no sessionId");
    return result.sessionId;
  };

  /** Loads a session; `replay` is every update that arrived between the request and its response. */
  const load = async (id: number, sessionId: string) => {
    const from = frames.length;
    const response = await request(id, "session/load", { sessionId, cwd: CWD, mcpServers: [] });
    return { response, replay: updates(frames.slice(from, frames.indexOf(response))) };
  };

  const close = (code: number, reason: string): Promise<number> =>
    new Promise((resolve) => {
      ws.addEventListener("close", (event) => resolve(event.code));
      ws.close(code, reason);
    });

  return { connection, messages, frames, until, send, sendLine, request, newSession, load, close };
};

/** The session/update payloads in the order they arrived. */
export const updates = (frames: ReadonlyArray<Frame>) =>
  frames.filter((frame) => frame.method === "session/update").map((frame) => frame.params.update);

export const prompt = (sessionId: string, text: string) => ({
  sessionId,
  prompt: [{ type: "text", text }],
});

/** A double's JSON state, such as its request log. */
export const double = async <A>(url: string): Promise<A> => (await fetch(url)).json();

export const toolResult = (frames: ReturnType<typeof updates>, toolCallId: string) =>
  frames.find(
    (update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === toolCallId,
  );

/** The App's two calls for a test/github token: find the installation, then mint for that repo alone. */
export const MINT_GITHUB_TOKEN = [
  { method: "GET", path: "/repos/test/github/installation", body: null },
  {
    method: "POST",
    path: "/app/installations/1/access_tokens",
    body: {
      repositories: ["github"],
      permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "read",
        metadata: "read",
      },
    },
  },
];

/** One of the GitHub App's calls to mint a token. */
export const isMint = (request: { path: string }) =>
  request.path.endsWith("/installation") || request.path.endsWith("/access_tokens");
