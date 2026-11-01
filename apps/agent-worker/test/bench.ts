import { it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { CommitSha, RepoId } from "@dorbs/protocol/checker";
import { env } from "cloudflare:workers";
import * as Schema from "effect/Schema";

import { buildBase } from "../src/base.ts";
import { cloneRepo } from "../src/cloneRepo.ts";
import type { AcpSession } from "./worker.ts";

/**
 * A session's workspace work on a real repo, timed and metered: run with DORBS_BENCH_REPO set to a bare clone whose
 * HEAD has a parent, the commit a base already exists for, as when main moved since the last clone.
 */

const ROOT = "/workspace";
const ORIGIN = { url: "http://git.test/bench.git", headers: undefined };
const REPO = "test/bench";
const decodeRepo = Schema.decodeUnknownSync(RepoId);
const decodeCommit = Schema.decodeUnknownSync(CommitSha);

const READS = [
  "apps/desktop/src/app/DesktopAppActivation.ts",
  "apps/desktop/src/snapShot/CaptureShortcutConfig.ts",
  "apps/mobile/src/components/ui/NativeAppBar.android.tsx",
  "apps/mobile/src/features/files/FilesHeader.tsx",
  "apps/mobile/src/features/pull-requests/pullRequestSelection.ts",
  "apps/mobile/src/features/threads/ComposerAttachmentButton.tsx",
  "apps/mobile/src/lib/markdownMediaSource.ts",
  "apps/mobile/src/state/projects.ts",
  "apps/server/src/bootstrap.ts",
  "apps/server/src/htmlRender/publicProxy.ts",
  "apps/server/src/orchestration-v2/ProviderContinuationService.test.ts",
  "apps/server/src/persistence/Migrations/016_CanonicalizeModelSelections.ts",
  "apps/server/src/provider/CodexChatGptAuth.ts",
  "apps/server/src/secrets/secretProviderDefinitions.test.ts",
  "apps/web/src/browser/previewWebviewConfigState.ts",
  "apps/web/src/components/chat/WorkflowOpeningBlock.tsx",
  "apps/web/src/components/clerk/useT3ConnectAuthPrompt.tsx",
  "apps/web/src/components/settings/ProviderAuthenticationSection.tsx",
  "package.json",
  "README.md",
];

// What eval agents searched the whole repo for first.
const GREPS = [
  "thinkingCapabilities",
  "is[A-Z][A-Za-z]+Level",
  "modelPickerVisibility|registerModelPickerContent|isModelPickerOpen",
  "Finish signing in",
  "menu-placement",
  "summarizeDeltaItem",
  "ProposedPlanCard",
  "export const [a-z]+Schema",
];

const EDITS = [
  "apps/web/src/components/settings/ProviderAuthenticationSection.tsx",
  "apps/server/src/bootstrap.ts",
  "apps/mobile/src/state/projects.ts",
];

type Meter = { readonly written: number; readonly read: number };

const meter = (sql: SqlStorage) => {
  const cursors: Array<{ readonly rowsWritten: number; readonly rowsRead: number }> = [];
  const exec = sql.exec.bind(sql);
  Object.defineProperty(sql, "exec", {
    value: (query: string, ...bindings: unknown[]) => {
      const cursor = exec(query, ...bindings);
      cursors.push(cursor);
      return cursor;
    },
  });
  return (): Meter => {
    const rows = cursors.reduce(
      (sum, cursor) => ({
        written: sum.written + cursor.rowsWritten,
        read: sum.read + cursor.rowsRead,
      }),
      { written: 0, read: 0 },
    );
    cursors.length = 0;
    return rows;
  };
};

/** Counts R2 reads and the bytes they return, on the binding every Base reads through. */
const r2 = (bucket: R2Bucket) => {
  let gets = 0;
  let bytes = 0;
  const get = bucket.get.bind(bucket);
  Object.defineProperty(bucket, "get", {
    value: async (key: string, options?: R2GetOptions) => {
      gets += 1;
      const object = await get(key, options);
      const range = options?.range;
      const length = range !== undefined && "length" in range ? range.length : undefined;
      bytes += object === null ? 0 : (length ?? object.size);
      return object;
    },
  });
  return () => {
    const out = { gets, mb: Math.round(bytes / 1e5) / 10 };
    gets = 0;
    bytes = 0;
    return out;
  };
};

const timed = async <A>(
  work: () => Promise<A>,
): Promise<{ readonly ms: number; readonly value: A }> => {
  const started = performance.now();
  const value = await work();
  return { ms: Math.round(performance.now() - started), value };
};

it(
  "times and meters a session's workspace work on a real repo",
  { timeout: 30 * 60_000 },
  async () => {
    const parent = await (await fetch("http://git.test/__bench")).json<string>();
    const report: Record<string, unknown> = {};
    const reads = r2(env.Bases);

    const cold = await timed(() => buildBase(env.Bases, ORIGIN, REPO, parent));
    report["coldBuild"] = { ms: cold.ms, r2: reads() };

    await runInDurableObject(
      env.AcpSession.getByName("bench"),
      async (instance: AcpSession, state) => {
        const rows = meter(state.storage.sql);
        const cloned = await timed(() =>
          cloneRepo(instance.fs, instance.toolHost.bases, ORIGIN, REPO, ROOT, "bench"),
        );
        const clone = {
          repo: decodeRepo(REPO),
          commit: decodeCommit(cloned.value.commit),
          branch: cloned.value.branch,
          base: cloned.value.base,
        };
        instance.toolHost.saveClone(clone);
        report["cloneAfterMainMoved"] = { ms: cloned.ms, rows: rows(), r2: reads() };

        const read = await timed(async () => {
          for (const path of READS) await instance.fs.readText(`${ROOT}/${path}`);
        });
        report["read20"] = { ms: read.ms, rows: rows(), r2: reads() };

        const greps: Record<string, unknown> = {};
        for (const pattern of GREPS) {
          const found = await timed(() => instance.fs.grep(new RegExp(pattern, "u"), ROOT, 200));
          greps[pattern] = { ms: found.ms, matches: found.value.length, r2: reads() };
        }
        report["grep"] = greps;
        report["grepRows"] = rows();

        const edit = await timed(async () => {
          for (const path of EDITS) {
            const text = await instance.fs.readText(`${ROOT}/${path}`);
            await instance.fs.readText(`${ROOT}/${path}`);
            await instance.fs.writeFile(`${ROOT}/${path}`, `${text}\n// edited by the bench\n`);
          }
        });
        report["edit3"] = { ms: edit.ms, rows: rows(), r2: reads() };

        const { git } = await import("../src/git.ts");
        const context = {
          workspace: instance.workspace,
          fs: instance.fs,
          dir: ROOT,
          clone,
          created: () => {},
          url: undefined,
          headers: async () => undefined,
        };
        const gitSteps: Record<string, unknown> = {};
        for (const line of [
          "checkout -b dorbs/bench",
          "status",
          `add ${EDITS.join(" ")}`,
          'commit -m "bench edits"',
          "status",
          "log -n 3 --oneline",
          "show --stat",
          "log -n 2 --stat",
        ]) {
          const step = await timed(() => git(line, context));
          gitSteps[line] = {
            ms: step.ms,
            rows: rows(),
            r2: reads(),
            out: step.value.slice(0, 120),
          };
        }
        report["git"] = gitSteps;
      },
    );

    await runInDurableObject(
      env.AcpSession.getByName("bench-warm"),
      async (instance: AcpSession, state) => {
        const rows = meter(state.storage.sql);
        const cloned = await timed(() =>
          cloneRepo(instance.fs, instance.toolHost.bases, ORIGIN, REPO, ROOT, "bench-warm"),
        );
        report["warmClone"] = { ms: cloned.ms, rows: rows(), r2: reads() };
      },
    );
    await fetch("http://git.test/__bench/report", {
      method: "POST",
      body: JSON.stringify(report, null, 1),
    });
  },
);
