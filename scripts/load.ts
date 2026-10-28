// Opens N concurrent sessions on a running `pnpm live` stack, one nc per session as T3 Code spawns per
// thread, prompts them all at once, and prints per-session latency. Pair it with a process sampler.
//   pnpm load 100

import * as NodeChildProcess from "node:child_process";

import { acpClient, prompt, T3_INITIALIZE_LINE } from "./stack.ts";

const SOCKET = "/tmp/dorbs-acp.sock";
const CWD = "/tmp/dorbs-live-project";
const count = Number(process.argv[2] ?? "10");

type Result = {
  readonly n: number;
  readonly ms: number;
  readonly outcome: string;
  readonly tools: number;
  readonly checked: boolean;
};

const session = async (n: number): Promise<Result> => {
  const nc = NodeChildProcess.spawn("/usr/bin/nc", ["-U", SOCKET], {
    cwd: CWD,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = acpClient(nc);
  const startedAt = performance.now();
  try {
    client.sendLine(T3_INITIALIZE_LINE);
    await client.next((frame) => frame.id === 1073741824, 60_000, `initialize #${n}`);
    const created = await client.request(2, "session/new", { cwd: CWD, mcpServers: [] }, 60_000);
    const sessionId: string = created.result.sessionId;
    const text =
      `Clone the repo dorbs/live. Add src/load${n}.ts exporting load${n}(xs: number[]): number. ` +
      "Run the typecheck tool, fix any errors, then reply with one sentence.";
    const answer = await client.request(3, "session/prompt", prompt(sessionId, text), 600_000);
    const updates = client.updates(sessionId);
    return {
      n,
      ms: Math.round(performance.now() - startedAt),
      outcome: answer.result?.stopReason ?? `error ${answer.error?.message}`,
      tools: updates.filter((u) => u.sessionUpdate === "tool_call").length,
      checked: updates.some(
        (u) =>
          u.sessionUpdate === "tool_call_update" &&
          u.status === "completed" &&
          JSON.stringify(u.content ?? []).includes("No diagnostics."),
      ),
    };
  } catch (error) {
    return {
      n,
      ms: Math.round(performance.now() - startedAt),
      outcome: error instanceof Error ? error.message : String(error),
      tools: 0,
      checked: false,
    };
  } finally {
    nc.stdin.end();
  }
};

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

console.log(`start ${new Date().toISOString()} sessions=${count}`);
const results = await Promise.all(Array.from({ length: count }, (_, i) => session(i + 1)));
console.log(`end ${new Date().toISOString()}`);
const answered = results.filter((r) => r.outcome === "end_turn");
const ms = answered.map((r) => r.ms).toSorted((a, b) => a - b);
console.log(
  `end_turn ${answered.length}/${count}; clean typecheck ${results.filter((r) => r.checked).length}; ` +
    `tool calls ${results.reduce((s, r) => s + r.tools, 0)}; ` +
    `latency ms p50 ${percentile(ms, 50)} p90 ${percentile(ms, 90)} max ${ms.at(-1) ?? 0}`,
);
for (const failed of results.filter((r) => r.outcome !== "end_turn")) {
  console.log(`not ok #${failed.n} after ${failed.ms} ms: ${failed.outcome}`);
}
