// The local chain T3 Code drives: nc -U -> acp-mux -> agent Worker (alchemy dev) -> typecheck service.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeAssert from "node:assert/strict";

import { makeRepo, nodeListener, serveGit, type FixtureFile } from "./gitFixture.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const WORKER_DIR = NodePath.join(ROOT, "apps/agent-worker");

/** A minimal strict TypeScript project for the agent to clone. */
export const TS_PROJECT = {
  "package.json": '{ "name": "dorbs-e2e", "private": true }\n',
  "tsconfig.json":
    '{ "compilerOptions": { "strict": true, "noEmit": true }, "include": ["src"] }\n',
  "src/index.ts": "export const greeting = 'hi';\n",
};

// Captured from T3 Code 125b619, as in packages/protocol/src/jsonrpc.test.ts.
export const T3_INITIALIZE_LINE =
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

export const ok = (step: string) => console.log(`ok ${step}`);

export const within = <A>(ms: number, what: string, promise: Promise<A>): Promise<A> =>
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

export const until = async <A>(
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
export const stopAll = async (): Promise<string[]> => {
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

export const muxConnectionsTo = (muxPid: number, port: number) => {
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
export const acpClient = (nc: NodeChildProcess.ChildProcessWithoutNullStreams) => {
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
  const server = NodeHttp.createServer(nodeListener(serveGit(root)));
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
};

export const prompt = (sessionId: string, text: string) => ({
  sessionId,
  prompt: [{ type: "text", text }],
});

/** The agent loop the stack's Worker runs new sessions on: HARNESS, pi unless set. */
export const harness = (): "pi" | "opencode" => {
  const name = process.env.HARNESS ?? "pi";
  if (name !== "pi" && name !== "opencode")
    throw new Error(`HARNESS must be pi or opencode, not ${name}`);
  return name;
};

export type StackOptions = {
  readonly repo: string;
  readonly harness: "pi" | "opencode";
  readonly fixture: Record<string, FixtureFile>;
  /** The cwd T3 Code would send in session/new; nc starts here. */
  readonly cwd: string;
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly openrouterKey: string;
  };
  /** A fixed path for T3 Code's Local ACP command; a fresh temp path by default. */
  readonly socketPath?: string;
};

export const startStack = async (options: StackOptions) => {
  const typecheckPort = await freePort();
  const typecheckToken = NodeCrypto.randomBytes(16).toString("hex");
  const agentToken = NodeCrypto.randomBytes(16).toString("hex");
  const dataDir = tempDir("dorbs-e2e-data-");
  const gitRoot = tempDir("dorbs-e2e-git-");
  const gitDir = NodePath.join(gitRoot, "repo.git");
  const commit = makeRepo(gitDir, options.fixture);
  const gitUrl = `http://127.0.0.1:${await gitServer(gitRoot)}/repo.git`;
  const reposFile = NodePath.join(gitRoot, "repos.json");
  NodeFS.writeFileSync(reposFile, JSON.stringify([{ id: options.repo, url: gitUrl }]));
  ok(`${options.repo} at ${commit} is served on ${gitUrl}`);
  const socketPath = options.socketPath ?? NodePath.join(tempDir("dorbs-e2e-mux-"), "mux.sock");
  const createdCwd = !NodeFS.existsSync(options.cwd);
  NodeFS.mkdirSync(options.cwd, { recursive: true });
  if (createdCwd) tempDirs.push(options.cwd);

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
        HARNESS: options.harness,
        MODEL_PROVIDER: options.model.provider,
        MODEL_ID: options.model.id,
        REPOS: JSON.stringify([{ id: options.repo, url: gitUrl }]),
        OPENROUTER_API_KEY: options.model.openrouterKey,
      },
    },
  );
  const [, workerUrl] = await waitForOutput(
    worker,
    /Started in \d+ms → (http:\/\/[^\s/]+)/u,
    90_000,
  );
  const workerPort = Number(new URL(workerUrl ?? "").port);
  ok(`agent Worker runs under alchemy dev at ${workerUrl} with HARNESS=${options.harness}`);

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
      cwd: options.cwd,
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

  return {
    typecheckPort,
    typecheckToken,
    dataDir,
    commit,
    gitDir,
    gitUrl,
    socketPath,
    workerUrl,
    workerPort,
    mux,
    startNc,
    stopNc,
  };
};

const cleanup = async () => {
  await stopAll();
  for (const server of servers.splice(0)) server.close();
  removeStageState();
  for (const dir of tempDirs) NodeFS.rmSync(dir, { recursive: true, force: true });
};

// Ctrl-C and a background stop both tear the stack down; otherwise workerd and the typecheck service outlive us.
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(code));
  });
}

/** Runs `main`, prints `not ok` and each child's output tail on failure, and always tears the stack down. */
export const runMain = async (main: () => Promise<void>) => {
  try {
    await main();
  } catch (error) {
    console.log(`not ok ${error instanceof Error ? error.message : String(error)}`);
    for (const child of children) {
      console.log(`--- ${child.name} output (tail) ---\n${child.output().slice(-3000)}`);
    }
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
};
