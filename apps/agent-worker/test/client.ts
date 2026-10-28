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
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
  ws.addEventListener("message", (event) => {
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

  const close = (code: number, reason: string): Promise<number> =>
    new Promise((resolve) => {
      ws.addEventListener("close", (event) => resolve(event.code));
      ws.close(code, reason);
    });

  return { connection, frames, until, send, sendLine, request, newSession, close };
};

/** The session/update payloads in the order they arrived. */
export const updates = (frames: ReadonlyArray<Frame>) =>
  frames.filter((frame) => frame.method === "session/update").map((frame) => frame.params.update);
