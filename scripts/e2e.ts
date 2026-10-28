// Drives the local chain the way T3 Code does: nc -U -> acp-mux -> agent Worker (alchemy dev) -> typecheck service.

import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { makeRepo, serveGit } from "./gitFixture.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const WORKER_DIR = NodePath.join(ROOT, "apps/agent-worker");
const CWD = "/tmp/dorbs-e2e-project";
const HELLO = 'export const n: number = "x";\n';
const TYPECHECK_OUTPUT =
  "src/hello.ts:1:14 error TS2322 Type 'string' is not assignable to type 'number'. (tsrs)";
const REPO = "dorbs/e2e";
const FIXTURE = {
  "package.json": '{ "name": "dorbs-e2e", "private": true }\n',
  "tsconfig.json":
    '{ "compilerOptions": { "strict": true, "noEmit": true }, "include": ["src"] }\n',
  "src/index.ts": "export const greeting = 'hi';\n",
};

// Captured from T3 Code 125b619, as in packages/protocol/src/jsonrpc.test.ts.
const T3_INITIALIZE_LINE =
  '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":2,"info":{"name":"t3-code","version":"0.0.0"},"capabilities":{"elicitation":{"form":{}}},"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"elicitation":{"form":{}}},"clientInfo":{"name":"t3-code","version":"0.0.0"}},"id":1073741824,"traceId":"a895982fd0f222068500d20ac5e4f5e4","spanId":"2715004bf08acd5c","sampled":true}\n';

type Frame = {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: any;
  readonly result?: any;
  readonly error?: { readonly code: number; readonly message: string };
};

type Child = {
  readonly name: string;
  readonly proc: NodeChildProcess.ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<number | null>;
};

const children: Child[] = [];
const servers: NodeHttp.Server[] = [];
const tempDirs: string[] = [];
const stage = `e2e${NodeCrypto.randomBytes(4).toString("hex")}`;

const ok = (step: string) => console.log(`ok ${step}`);

const within = <A>(ms: number, what: string, promise: Promise<A>): Promise<A> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async <A>(
  ms: number,
  what: string,
  probe: () => A | undefined | Promise<A | undefined>,
) =>
  within(
    ms,
    what,
    (async () => {
      for (;;) {
        const value = await probe();
        if (value !== undefined) return value;
        await pause(100);
      }
    })(),
  );

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });

const accepts = (port: number) =>
  new Promise<true | undefined>((resolve) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(undefined));
  });

const tempDir = (prefix: string) => {
  // Under /tmp, not os.tmpdir(): macOS's long tmpdir pushes a socket path past the 104-byte limit.
  const dir = NodeFS.mkdtempSync(`/tmp/${prefix}`);
  tempDirs.push(dir);
  return dir;
};

// Each daemon leads its own process group, so teardown also reaches pnpm's and alchemy's children (workerd).
const start = (
  name: string,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string> },
): Child => {
  const proc = NodeChildProcess.spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let text = "";
  proc.stdout?.on("data", (chunk: Buffer) => (text += chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => (text += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));
  const child = { name, proc, output: () => text, exited };
  children.push(child);
  return child;
};

const waitForOutput = (child: Child, pattern: RegExp, ms: number) =>
  until(ms, `${child.name} to print ${pattern}`, () => {
    if (child.proc.exitCode !== null) {
      throw new Error(`${child.name} exited ${child.proc.exitCode}:\n${child.output()}`);
    }
    return pattern.exec(child.output()) ?? undefined;
  });

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Stops every child's process group; returns the names of groups that outlived SIGTERM. */
const stopAll = async (): Promise<string[]> => {
  const survivors: string[] = [];
  for (const child of children.toReversed()) {
    const pid = child.proc.pid;
    if (pid === undefined || !groupAlive(pid)) continue;
    process.kill(-pid, "SIGTERM");
    const gone = await until(10_000, `${child.name} to exit`, () =>
      groupAlive(pid) ? undefined : true,
    ).catch(() => false);
    if (!gone) {
      survivors.push(child.name);
      if (groupAlive(pid)) process.kill(-pid, "SIGKILL");
    }
  }
  children.length = 0;
  return survivors;
};

const removeStageState = () => {
  const alchemy = NodePath.join(WORKER_DIR, ".alchemy");
  const targets = [
    NodePath.join(alchemy, "state/AgentWorker", stage),
    NodePath.join(alchemy, "log", stage),
    ...["bundles", "local"].flatMap((dir) => {
      const parent = NodePath.join(alchemy, dir);
      if (!NodeFS.existsSync(parent)) return [];
      return NodeFS.readdirSync(parent)
        .filter((entry) => entry.includes(`-${stage}-`))
        .map((entry) => NodePath.join(parent, entry));
    }),
  ];
  for (const target of targets) NodeFS.rmSync(target, { recursive: true, force: true });
};

const muxConnectionsTo = (muxPid: number, port: number) => {
  const result = NodeChildProcess.spawnSync(
    "/usr/sbin/lsof",
    ["-a", "-p", String(muxPid), "-iTCP", "-sTCP:ESTABLISHED", "-n", "-P", "-Fn"],
    { encoding: "utf8" },
  );
  const peers = [`->127.0.0.1:${port}`, `->[::1]:${port}`];
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("n") && peers.some((peer) => line.endsWith(peer))).length;
};

/** An ACP client on nc's stdin and stdout, as T3 Code holds one. */
const acpClient = (nc: NodeChildProcess.ChildProcessWithoutNullStreams) => {
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
  let broken: Error | undefined;
  NodeReadline.createInterface({ input: nc.stdout }).on("line", (line) => {
    try {
      frames.push(JSON.parse(line));
    } catch {
      broken ??= new Error(`nc printed a line that is not JSON-RPC: ${JSON.stringify(line)}`);
    }
    for (const wake of waiters) wake();
  });
  const next = (match: (frame: Frame) => boolean, ms: number, what: string) =>
    within(
      ms,
      what,
      new Promise<Frame>((resolve, reject) => {
        const check = () => {
          if (broken !== undefined) {
            waiters.delete(check);
            reject(broken);
            return;
          }
          const found = frames.find(match);
          if (found === undefined) return;
          waiters.delete(check);
          resolve(found);
        };
        waiters.add(check);
        check();
      }),
    );
  const sendLine = (line: string) => nc.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
  const send = (frame: Frame) => sendLine(JSON.stringify({ jsonrpc: "2.0", ...frame }));
  const request = (id: number, method: string, params: unknown, ms: number) => {
    send({ id, method, params });
    return next((frame) => frame.id === id && frame.method === undefined, ms, `${method} #${id}`);
  };
  const updates = (sessionId: string) =>
    frames
      .filter((frame) => frame.method === "session/update" && frame.params?.sessionId === sessionId)
      .map((frame) => frame.params.update);
  return { frames, next, sendLine, send, request, updates };
};

/** Serves the bare repos under `root` over git's smart HTTP on a free port. */
const gitServer = async (root: string): Promise<number> => {
  const handle = serveGit(root);
  const server = NodeHttp.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const answer = await handle(
        new Request(`http://127.0.0.1${request.url ?? "/"}`, {
          method: request.method ?? "GET",
          headers,
          ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
        }),
      );
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(Buffer.from(await answer.arrayBuffer()));
    })();
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
};

const prompt = (sessionId: string, text: string) => ({
  sessionId,
  prompt: [{ type: "text", text }],
});

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

const run = async () => {
  const typecheckPort = await freePort();
  const typecheckToken = NodeCrypto.randomBytes(16).toString("hex");
  const agentToken = NodeCrypto.randomBytes(16).toString("hex");
  const dataDir = tempDir("dorbs-e2e-data-");
  const gitRoot = tempDir("dorbs-e2e-git-");
  const commit = makeRepo(NodePath.join(gitRoot, "e2e.git"), FIXTURE);
  const gitUrl = `http://127.0.0.1:${await gitServer(gitRoot)}/e2e.git`;
  const reposFile = NodePath.join(gitRoot, "repos.json");
  NodeFS.writeFileSync(reposFile, JSON.stringify([{ id: REPO, url: gitUrl }]));
  ok(`${REPO} at ${commit} is served on ${gitUrl}`);
  const socketPath = NodePath.join(tempDir("dorbs-e2e-mux-"), "mux.sock");
  const createdCwd = !NodeFS.existsSync(CWD);
  NodeFS.mkdirSync(CWD, { recursive: true });
  if (createdCwd) tempDirs.push(CWD);

  const typecheck = start("typecheck", "pnpm", ["--filter", "@dorbs/typecheck", "start"], {
    cwd: ROOT,
    env: {
      PORT: String(typecheckPort),
      DATA_DIR: dataDir,
      REPOS_FILE: reposFile,
      TYPECHECK_TOKEN: typecheckToken,
    },
  });
  await until(30_000, "typecheck to listen", async () => {
    if (typecheck.proc.exitCode !== null)
      throw new Error(`typecheck exited:\n${typecheck.output()}`);
    return accepts(typecheckPort);
  });
  ok(`typecheck service listens on 127.0.0.1:${typecheckPort}`);

  const worker = start(
    "agent-worker",
    "pnpm",
    ["exec", "alchemy", "dev", "--no-input", "--stage", stage],
    {
      cwd: WORKER_DIR,
      env: {
        AGENT_TOKEN: agentToken,
        TYPECHECK_URL: `http://127.0.0.1:${typecheckPort}`,
        TYPECHECK_TOKEN: typecheckToken,
        MODEL_PROVIDER: "scripted",
        MODEL_ID: "scripted",
        REPOS: JSON.stringify([{ id: REPO, url: gitUrl }]),
        OPENROUTER_API_KEY: "unused-by-the-scripted-model",
      },
    },
  );
  const [, workerUrl] = await waitForOutput(
    worker,
    /Started in \d+ms → (http:\/\/[^\s/]+)/u,
    90_000,
  );
  const workerPort = Number(new URL(workerUrl ?? "").port);
  ok(`agent Worker runs under alchemy dev at ${workerUrl}`);

  const mux = start("acp-mux", process.execPath, ["src/main.ts"], {
    cwd: NodePath.join(ROOT, "apps/acp-mux"),
    env: {
      MUX_SOCKET_PATH: socketPath,
      AGENT_URL: (workerUrl ?? "").replace(/^http/u, "ws"),
      AGENT_TOKEN: agentToken,
    },
  });
  await waitForOutput(mux, /acp-mux listening on/u, 15_000);
  ok(`acp-mux listens on ${socketPath}`);

  /** Starts nc the way T3 Code launches the Local ACP command, and initializes ACP over it. */
  const startNc = async () => {
    const nc = NodeChildProcess.spawn("/usr/bin/nc", ["-U", socketPath], {
      cwd: CWD,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => nc.once("exit", resolve));
    const client = acpClient(nc);
    client.sendLine(T3_INITIALIZE_LINE);
    const initialized = await client.next((frame) => frame.id === 1073741824, 30_000, "initialize");
    NodeAssert.deepEqual(
      {
        protocolVersion: initialized.result?.protocolVersion,
        loadSession: initialized.result?.agentCapabilities?.loadSession,
      },
      { protocolVersion: 1, loadSession: true },
      JSON.stringify(initialized),
    );
    ok("initialize answers protocolVersion 1 with loadSession");
    return { nc, exited, client };
  };

  const stopNc = async ({ nc, exited }: Awaited<ReturnType<typeof startNc>>) => {
    nc.stdin.end();
    const code = await within(3_000, "nc to exit on stdin EOF", exited).catch(() => {
      // T3 Code ends a thread's command by killing it.
      nc.kill("SIGTERM");
      return within(3_000, "nc to exit on SIGTERM", exited);
    });
    ok(`nc exited (${code === null ? "signal" : `code ${code}`})`);
    await until(5_000, "acp-mux to close its WebSocket", () =>
      muxConnectionsTo(mux.proc.pid ?? 0, workerPort) === 0 ? true : undefined,
    );
    ok("acp-mux closed its WebSocket to the Worker");
  };

  const firstNc = await startNc();
  const { client } = firstNc;

  const created = await client.request(2, "session/new", { cwd: CWD, mcpServers: [] }, 15_000);
  const sessionId: unknown = created.result?.sessionId;
  NodeAssert.match(String(sessionId), /^[0-9a-f-]{36}$/u, JSON.stringify(created));
  if (typeof sessionId !== "string") throw new Error("unreachable");
  ok(`session/new returns sessionId ${sessionId}`);
  NodeAssert.equal(muxConnectionsTo(mux.proc.pid ?? 0, workerPort), 1);
  ok(`acp-mux holds one WebSocket to port ${workerPort}`);

  const first = await client.request(3, "session/prompt", prompt(sessionId, "e2e"), 120_000);
  const updates = client.updates(sessionId);
  const toolText = (toolCallId: string) =>
    updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === toolCallId)
      ?.content;
  NodeAssert.deepEqual(toolText("call-clone"), [
    {
      type: "content",
      content: {
        type: "text",
        text: `Cloned ${REPO} at ${commit} into the workspace root. Paths are relative to the repo root.`,
      },
    },
  ]);
  ok(`clone_repo cloned ${REPO} at ${commit} over HTTP`);
  const helloCall = updates.find(
    (u) => u.sessionUpdate === "tool_call" && u.toolCallId === "call-hello",
  );
  NodeAssert.deepEqual(
    { title: helloCall?.title, kind: helloCall?.kind, locations: helloCall?.locations },
    {
      title: "write_file src/hello.ts",
      kind: "edit",
      locations: [{ path: `${CWD}/src/hello.ts` }],
    },
  );
  ok("tool_call write_file src/hello.ts");
  const helloDone = updates.find(
    (u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call-hello",
  );
  NodeAssert.equal(helloDone?.status, "completed", JSON.stringify(helloDone));
  NodeAssert.deepEqual(
    helloDone.content.find((c: { type: string }) => c.type === "diff"),
    { type: "diff", path: `${CWD}/src/hello.ts`, newText: HELLO },
  );
  ok(`tool_call_update diff ${CWD}/src/hello.ts with newText ${JSON.stringify(HELLO)}`);
  NodeAssert.deepEqual(
    NodeFS.readdirSync(NodePath.join(dataDir, "blobs")),
    [sha256(HELLO)],
    "the typecheck service received exactly the blob of src/hello.ts",
  );
  ok("the check carried only src/hello.ts, the one file changed since the commit");
  NodeAssert.deepEqual(toolText("call-typecheck"), [
    { type: "content", content: { type: "text", text: TYPECHECK_OUTPUT } },
  ]);
  ok(`typecheck tool_call_update from the real service: ${TYPECHECK_OUTPUT}`);
  const protectedOutput =
    `Not checked: package.json changed. The check takes dependencies and config from commit ${commit}, ` +
    "so dependency and config changes must be pushed first. Undo these changes to check the rest.";
  NodeAssert.deepEqual(toolText("call-typecheck-package"), [
    { type: "content", content: { type: "text", text: protectedOutput } },
  ]);
  ok("a package.json change gets the ProtectedPaths rejection text");
  const repeated = await fetch(`http://127.0.0.1:${typecheckPort}/actions`, {
    method: "POST",
    headers: { authorization: `Bearer ${typecheckToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "check",
      toolchain: "node26-tsrs0.20-oxlint1.89",
      repo: REPO,
      commit,
      files: [{ path: "src/hello.ts", sha256: sha256(HELLO) }],
      deleted: [],
    }),
  }).then((response) => response.json());
  NodeAssert.deepEqual(
    { tag: repeated._tag, cached: repeated.cached, outputs: repeated.outputs },
    { tag: "ActionResult", cached: true, outputs: [] },
    JSON.stringify(repeated),
  );
  NodeAssert.deepEqual(
    repeated.diagnostics.map(
      (d: { path: string; line: number; column: number; code: string; tool: string }) =>
        `${d.path}:${d.line}:${d.column} ${d.code} (${d.tool})`,
    ),
    ["src/hello.ts:1:14 TS2322 (tsrs)"],
  );
  ok("the agent's check, repeated as the same action, is served from the action cache");
  const message = updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content.text)
    .join("");
  NodeAssert.equal(message, "n is a string.");
  ok(`agent_message_chunk ${JSON.stringify(message)}`);
  NodeAssert.deepEqual(first.result, { stopReason: "end_turn" }, JSON.stringify(first));
  ok("first prompt resolves with stopReason end_turn");

  // T3 Code ends a thread's command by killing it, as on its 30-minute idle unload.
  firstNc.nc.kill("SIGTERM");
  await within(3_000, "nc to exit on SIGTERM", firstNc.exited);
  await until(5_000, "acp-mux to close its WebSocket", () =>
    muxConnectionsTo(mux.proc.pid ?? 0, workerPort) === 0 ? true : undefined,
  );
  ok("killed nc after the first turn; acp-mux closed its WebSocket");

  const secondNc = await startNc();
  const reloaded = secondNc.client;
  const load = { sessionId, cwd: CWD, mcpServers: [] };
  const loaded = await reloaded.request(2, "session/load", load, 15_000);
  NodeAssert.deepEqual(loaded.result, {}, JSON.stringify(loaded));
  const replayed = reloaded.frames
    .slice(0, reloaded.frames.indexOf(loaded))
    .filter((frame) => frame.method === "session/update" && frame.params?.sessionId === sessionId)
    .map((frame) => frame.params.update);
  NodeAssert.deepEqual(
    replayed.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call-hello")
      ?.content,
    helloDone.content,
    "the replay carries the first turn's diff of src/hello.ts",
  );
  NodeAssert.deepEqual(
    [replayed.at(0), replayed.at(-1)],
    [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "e2e" } },
      {
        sessionUpdate: "session_info_update",
        _meta: { "dorbs/turnEnded": { stopReason: "end_turn" } },
      },
    ],
  );
  NodeAssert.equal(
    replayed.length,
    updates.length + 2,
    "the replay is the first turn's updates, its prompt and its end",
  );
  ok(
    `session/load on a new nc replays ${replayed.length} updates, the src/hello.ts diff included, then answers`,
  );

  const read = await reloaded.request(3, "session/prompt", prompt(sessionId, "read hello"), 30_000);
  NodeAssert.deepEqual(read.result, { stopReason: "end_turn" }, JSON.stringify(read));
  const readUpdates = reloaded.updates(sessionId).slice(replayed.length);
  NodeAssert.deepEqual(
    readUpdates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call-read")
      ?.content,
    [{ type: "content", content: { type: "text", text: HELLO } }],
  );
  ok(`a prompt on the loaded session reads src/hello.ts: ${JSON.stringify(HELLO)}`);
  NodeAssert.deepEqual(readUpdates.at(-1), {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Prompts so far: e2e | read hello." },
  });
  ok("the model saw the first turn's prompt in the same Pi transcript");

  const long = reloaded.request(4, "session/prompt", prompt(sessionId, "wait for cancel"), 30_000);
  await reloaded.next(
    (f) =>
      f.params?.update?.sessionUpdate === "tool_call_update" &&
      f.params.update.toolCallId === "call-list",
    30_000,
    "the long prompt to reach its model wait",
  );
  const cancelledAt = performance.now();
  reloaded.send({ method: "session/cancel", params: { sessionId } });
  const cancelled = await within(5_000, "cancelled prompt to resolve", long);
  const cancelMs = Math.round(performance.now() - cancelledAt);
  NodeAssert.deepEqual(cancelled.result, { stopReason: "cancelled" }, JSON.stringify(cancelled));
  ok(`session/cancel resolves the second prompt with cancelled in ${cancelMs} ms`);

  const third = await reloaded.request(5, "session/prompt", prompt(sessionId, "anything"), 30_000);
  NodeAssert.deepEqual(third.result, { stopReason: "end_turn" }, JSON.stringify(third));
  ok("third prompt after cancel resolves with end_turn");

  await stopNc(secondNc);

  const survivors = await stopAll();
  NodeAssert.deepEqual(survivors, [], "process groups that outlived SIGTERM");
  ok("every child process group exited");
};

const cleanup = async () => {
  await stopAll();
  for (const server of servers.splice(0)) server.close();
  removeStageState();
  for (const dir of tempDirs) NodeFS.rmSync(dir, { recursive: true, force: true });
};

process.once("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});

try {
  await run();
} catch (error) {
  console.log(`not ok ${error instanceof Error ? error.message : String(error)}`);
  for (const child of children) {
    console.log(`--- ${child.name} output (tail) ---\n${child.output().slice(-3000)}`);
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}
