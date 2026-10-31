// One ACP session over an acp-mux socket, as T3 Code holds it: each turn's session/update frames, stamped on arrival.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

import { acpClient, prompt, T3_INITIALIZE_LINE } from "../stack.ts";

/** A session/update's `update`, and when it arrived, in ms since its turn's prompt was sent. */
export type Stamped = { readonly at: number; readonly update: any };

export type TurnRecord = {
  readonly text: string;
  /** ms from sending session/prompt to its response. */
  readonly wallMs: number;
  readonly stopReason: string | undefined;
  readonly error: string | undefined;
  readonly updates: ReadonlyArray<Stamped>;
};

export type SessionRecord = {
  readonly sessionId: string | undefined;
  readonly setupMs: number;
  readonly turns: ReadonlyArray<TurnRecord>;
  readonly error: string | undefined;
};

/** Opens nc on `socket`, makes a session in `cwd`, and sends `texts` as consecutive turns; stops at a failed turn. */
export const runSession = async (
  socket: string,
  cwd: string,
  texts: ReadonlyArray<string>,
  turnMs: number,
): Promise<SessionRecord> => {
  NodeFS.mkdirSync(cwd, { recursive: true });
  const t0 = performance.now();
  const nc = NodeChildProcess.spawn("/usr/bin/nc", ["-U", socket], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = acpClient(nc);
  const stamps: number[] = [];
  NodeReadline.createInterface({ input: nc.stdout }).on("line", () =>
    stamps.push(performance.now()),
  );
  const turns: TurnRecord[] = [];
  let sessionId: string | undefined;
  let setupMs = NaN;
  try {
    client.sendLine(T3_INITIALIZE_LINE);
    await client.next((f) => f.id === 1073741824, 60_000, "initialize");
    const created = await client.request(2, "session/new", { cwd, mcpServers: [] }, 60_000);
    sessionId = created.result?.sessionId;
    if (sessionId === undefined) throw new Error(`session/new: ${JSON.stringify(created)}`);
    setupMs = performance.now() - t0;
    for (const [index, text] of texts.entries()) {
      const from = client.frames.length;
      const sentAt = performance.now();
      const answer = await client
        .request(10 + index, "session/prompt", prompt(sessionId, text), turnMs)
        .catch((error: Error) => ({
          error: { code: -1, message: error.message },
          result: undefined,
        }));
      const to = client.frames.indexOf(answer);
      const end = to === -1 ? performance.now() : (stamps[to] ?? performance.now());
      const updates = client.frames
        .slice(from, to === -1 ? undefined : to)
        .map((frame, i) => ({ frame, at: (stamps[from + i] ?? NaN) - sentAt }))
        .filter(
          ({ frame }) => frame.method === "session/update" && frame.params?.sessionId === sessionId,
        )
        .map(({ frame, at }) => ({ at, update: frame.params.update }));
      turns.push({
        text,
        wallMs: end - sentAt,
        stopReason: answer.result?.stopReason,
        error: answer.error?.message,
        updates,
      });
      if (answer.result?.stopReason !== "end_turn") break;
    }
    return { sessionId, setupMs, turns, error: undefined };
  } catch (error) {
    return {
      sessionId,
      setupMs,
      turns,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    nc.stdin.end();
    setTimeout(() => nc.kill("SIGTERM"), 3_000).unref();
  }
};
