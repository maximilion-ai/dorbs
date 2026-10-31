// The checker's acceptance run on its host: for each repo, check HEAD through the service, run the
// repo's own check commands directly in the same container, compare the error sets, then check a
// probe error and a warm repeat. Needs docker access, so it runs where the service runs.
//   node scripts/checker-accept.ts [repo ...]   CHECK_URL, DATA_DIR and CONTAINER_PREFIX name another service.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { parseOutput } from "../apps/checker/src/diagnostics.ts";

type Case = {
  readonly repo: string;
  readonly commit: string;
  /** What the repo's own CI or scripts run, in the environment's repo root. */
  readonly own: ReadonlyArray<string>;
  readonly probe: { readonly path: string; readonly text: string };
};

const TS_PROBE = '\nexport const __dorbsProbe: number = "x";\n';
const CASES: ReadonlyArray<Case> = [
  {
    repo: "vitest-dev/vitest",
    commit: "42770759fcca4ff82ab4df49e4ee241f4f680e99",
    own: ["pnpm run typecheck", "pnpm run lint"],
    probe: { path: "packages/vitest/src/node/cli/cli-api.ts", text: TS_PROBE },
  },
  {
    repo: "tanstack/router",
    commit: "da2adec76dbe6c0da6d6a0d5640f7b9388217f45",
    own: ["pnpm exec tsc --noEmit -p tsconfig.json", "pnpm exec eslint ."],
    probe: { path: "packages/router-core/src/router.ts", text: TS_PROBE },
  },
  {
    repo: "vbenjs/vue-vben-admin",
    commit: "eb47a1e6947a6dfa434686c1abb55ce8a66b029b",
    own: ["pnpm exec turbo run typecheck --concurrency=2", "pnpm run lint"],
    probe: { path: "packages/@core/base/shared/src/utils/cn.ts", text: TS_PROBE },
  },
  {
    repo: "huntabyte/shadcn-svelte",
    commit: "fe4b0ad3b8b30c6745346db008c3307b5afeabb1",
    own: ["pnpm run check", "pnpm run lint"],
    probe: { path: "docs/src/lib/colors.ts", text: TS_PROBE },
  },
  {
    repo: "honojs/hono",
    commit: "17ad0e21f5a91c939eeafa3df05793a8ea60f016",
    own: ["pnpm run check", "pnpm run lint"],
    probe: { path: "src/hono.ts", text: TS_PROBE },
  },
  {
    repo: "sveltejs/realworld",
    commit: "df796708040f5200ec572b28ab7f88ecee5794dd",
    own: ["pnpm exec svelte-check", "pnpm run lint"],
    probe: {
      path: "src/lib/api.js",
      text: "\n/** @type {number} */\nexport const __dorbsProbe = 'x';\n",
    },
  },
  {
    repo: "nestjs/nest",
    commit: "db72d291097b0f7c165c0acf01ec4e3ce1d05f17",
    own: ["npx tsc -b packages", "npm run lint"],
    probe: { path: "packages/core/nest-application.ts", text: TS_PROBE },
  },
  {
    repo: "excalidraw/excalidraw",
    commit: "b99a49dbebd25fbf85ad9ae33c9e361a16d5a39e",
    own: ["yarn test:typecheck", "yarn test:code"],
    probe: { path: "packages/excalidraw/index.tsx", text: TS_PROBE },
  },
  {
    repo: "elysiajs/elysia",
    commit: "e037eca710e7ad193be09cc6615ab0dbe54af914",
    own: ["node_modules/.bin/tsc --noEmit -p tsconfig.json"],
    probe: { path: "src/index.ts", text: TS_PROBE },
  },
  {
    repo: "pydantic/pydantic-ai",
    commit: "c58f5352c836e565f2e52af911d2c92b05812375",
    own: [".venv/bin/pyright", ".venv/bin/ruff check"],
    probe: {
      path: "pydantic_ai_slim/pydantic_ai/_output.py",
      text: '\n__dorbs_probe: int = "x"\n',
    },
  },
  {
    repo: "searxng/searxng",
    commit: "ffa88e3ba3ade64185d5754c839cdf5a80708c4a",
    own: [".venv/bin/basedpyright"],
    probe: { path: "searx/webapp.py", text: '\n__dorbs_probe: int = "x"\n' },
  },
  {
    repo: "tokio-rs/axum",
    commit: "bebe175c334d2a4154b32cd9e477274c2aab5953",
    own: ["cargo check --workspace --all-targets --offline --locked"],
    probe: { path: "axum/src/routing/mod.rs", text: '\npub const __DORBS_PROBE: u32 = "x";\n' },
  },
  {
    repo: "cli/cli",
    commit: "9490d204a2ba95434153dedce99898ce9f281426",
    own: ["go build ./...", "go vet ./..."],
    probe: { path: "pkg/cmd/pr/shared/display.go", text: '\nvar dorbsProbe int = "x"\n' },
  },
];

const URL = process.env.CHECK_URL ?? "http://127.0.0.1:8790";
const DATA_DIR = process.env.DATA_DIR ?? `${process.env.HOME}/dorbs-checker/data`;
const PREFIX = process.env.CONTAINER_PREFIX ?? "dorbs";
const TOKEN = NodeFS.readFileSync(
  NodePath.join(NodeOS.homedir(), ".config/dorbs/check-token"),
  "utf8",
).trim();

type Diagnostic = {
  path: string;
  range: { start: { line: number } };
  severity: number;
  message: string;
};
type CheckRun = {
  id: string;
  status: string;
  diagnostics: ReadonlyArray<Diagnostic>;
  output: ReadonlyArray<string>;
};
type Answer =
  | {
      _tag: "CheckResult";
      envKey: string;
      durationMs: number;
      setupMs: number;
      overlayMs: number;
      checks: ReadonlyArray<CheckRun>;
    }
  | { _tag: "SetupFailed"; step: string; output: string }
  | { _tag: "Rejected"; reason: unknown };

const check = async (c: Case, files: ReadonlyArray<{ path: string; content: string }>) => {
  const started = performance.now();
  const response = await fetch(`${URL}/check`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ repo: c.repo, commit: c.commit, change: { files, deleted: [] } }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  const answer: Answer = JSON.parse(text);
  return { answer, wallMs: Math.round(performance.now() - started) };
};

const errorSet = (diagnostics: ReadonlyArray<Diagnostic>) =>
  new Set(
    diagnostics.filter((d) => d.severity === 1).map((d) => `${d.path}:${d.range.start.line + 1}`),
  );

const own = (container: string, command: string) => {
  const result = NodeChildProcess.spawnSync(
    "docker",
    ["exec", "-w", "/env/repo", container, "sh", "-c", command],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const parsed = parseOutput("text", result.stdout, result.stderr, {
    root: "/env/repo",
    cwd: ".",
    source: "own",
    packages: new Map(),
  });
  return { exit: result.status, parsed };
};

const only = process.argv.slice(2);
for (const c of CASES.filter((candidate) => only.length === 0 || only.includes(candidate.repo))) {
  const line: Array<string> = [c.repo];
  try {
    const head = await check(c, []);
    if (head.answer._tag !== "CheckResult") {
      console.log(`${c.repo}: ${JSON.stringify(head.answer).slice(0, 2000)}`);
      continue;
    }
    const result = head.answer;
    line.push(`cold ${head.wallMs} ms (setup ${result.setupMs} ms)`);
    line.push(result.checks.map((run) => `${run.id}=${run.status}`).join(","));
    const service = errorSet(result.checks.flatMap((run) => run.diagnostics));
    const container = `${PREFIX}-env-${result.envKey}`;
    const ownRuns = c.own.map((command) => ({ command, ...own(container, command) }));
    const direct = errorSet(ownRuns.flatMap((run) => run.parsed.diagnostics));
    const onlyService = [...service].filter((key) => !direct.has(key));
    const onlyOwn = [...direct].filter((key) => !service.has(key));
    line.push(
      `errors service ${service.size} own ${direct.size} (${ownRuns.map((run) => `exit ${run.exit}`).join(",")})` +
        (onlyService.length + onlyOwn.length === 0
          ? " SAME"
          : ` DIFF only-service ${onlyService.slice(0, 3).join(" ")} only-own ${onlyOwn.slice(0, 3).join(" ")}`),
    );
    const original = NodeChildProcess.execFileSync(
      "git",
      ["--git-dir", `${DATA_DIR}/git/${c.repo}.git`, "show", `${c.commit}:${c.probe.path}`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const probed = await check(c, [{ path: c.probe.path, content: original + c.probe.text }]);
    if (probed.answer._tag === "CheckResult") {
      const hit = probed.answer.checks
        .flatMap((run) => run.diagnostics)
        .some((d) => d.path === c.probe.path && d.severity === 1);
      line.push(
        `probe ${hit ? "hit" : "MISSED"} ${probed.wallMs} ms (overlay ${probed.answer.overlayMs} ms)`,
      );
    }
    const warm = await check(c, []);
    if (warm.answer._tag === "CheckResult")
      line.push(`warm ${warm.wallMs} ms (overlay ${warm.answer.overlayMs} ms)`);
  } catch (error) {
    line.push(`ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(line.join(" | "));
}
