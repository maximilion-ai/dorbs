// Sends one check or test request to the checker service and prints a summary, or the whole answer with --json.
//   node scripts/checker.ts check <owner/name> <commit> [--only id,id] [--put path=file] [--rm path] [--json]
//   node scripts/checker.ts test <owner/name> <commit> [--files a,b] [--filter x] [--put path=file] [--json]
// CHECK_URL defaults to http://127.0.0.1:8790; CHECK_TOKEN defaults to ~/.config/dorbs/check-token.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    only: { type: "string" },
    files: { type: "string" },
    filter: { type: "string" },
    put: { type: "string", multiple: true },
    rm: { type: "string", multiple: true },
    json: { type: "boolean" },
  },
});
const [action, repo, commit] = positionals;
if ((action !== "check" && action !== "test") || repo === undefined || commit === undefined) {
  console.error("usage: checker.ts check|test <owner/name> <commit> [options]");
  process.exit(2);
}
const url = process.env.CHECK_URL ?? "http://127.0.0.1:8790";
const token =
  process.env.CHECK_TOKEN ??
  NodeFS.readFileSync(NodePath.join(NodeOS.homedir(), ".config/dorbs/check-token"), "utf8").trim();

const change = {
  files: (values.put ?? []).map((pair) => {
    const at = pair.indexOf("=");
    return { path: pair.slice(0, at), content: NodeFS.readFileSync(pair.slice(at + 1), "utf8") };
  }),
  deleted: values.rm ?? [],
};
const body = {
  repo,
  commit,
  change,
  ...(action === "check" && values.only !== undefined ? { only: values.only.split(",") } : {}),
  ...(action === "test" && values.files !== undefined ? { files: values.files.split(",") } : {}),
  ...(action === "test" && values.filter !== undefined ? { filter: values.filter } : {}),
};

const started = performance.now();
const response = await fetch(`${url}/${action}`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const wallMs = Math.round(performance.now() - started);
const text = await response.text();
if (!response.ok) {
  console.log(`HTTP ${response.status} after ${wallMs} ms: ${text}`);
  process.exit(1);
}
const answer = JSON.parse(text);
if (values.json === true) {
  console.log(JSON.stringify({ wallMs, ...answer }, null, 2));
} else if (answer._tag === "CheckResult") {
  console.log(
    `${answer._tag} wall ${wallMs} ms, service ${answer.durationMs} ms, setup ${answer.setupMs} ms, overlay ${answer.overlayMs} ms, complete ${answer.complete}, env ${answer.envKey.slice(0, 12)}`,
  );
  for (const run of answer.checks) {
    const errors = run.diagnostics.filter((d: { severity: number }) => d.severity === 1).length;
    console.log(
      `  ${run.id}: ${run.status} exit ${run.exitCode} in ${run.durationMs} ms, ${errors} errors, ${run.diagnostics.length - errors} other diagnostics, ${run.output.length} output lines${run.truncated ? " (truncated)" : ""} :: ${run.command}`,
    );
  }
} else if (answer._tag === "TestResult") {
  console.log(
    `${answer._tag} wall ${wallMs} ms, service ${answer.durationMs} ms, setup ${answer.setupMs} ms, overlay ${answer.overlayMs} ms: ${answer.status} exit ${answer.exitCode}, passed ${answer.passed} failed ${answer.failed} skipped ${answer.skipped} :: ${answer.command}`,
  );
  console.log(answer.output.split("\n").slice(-15).join("\n"));
} else {
  console.log(JSON.stringify(answer, null, 2).slice(0, 6000));
}
