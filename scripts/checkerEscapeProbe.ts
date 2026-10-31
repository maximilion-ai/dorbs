// What a test or check may try from inside the checker's environment, as node --test tests that pass
// when each attempt fails. Send it as a test file:
//   node scripts/checker.ts test <repo> <commit> --files src/escape.test.ts --put src/escape.test.ts=scripts/checkerEscapeProbe.ts

import * as NodeAssert from "node:assert/strict";
import * as NodeDns from "node:dns/promises";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import { test } from "node:test";

const connect = (host: string, port: number) =>
  new Promise<void>((resolve, reject) => {
    const socket = NodeNet.createConnection({ host, port, timeout: 3000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
    socket.once("error", reject);
  });

test("reads no file of the host outside the environment", () => {
  for (const path of [
    "/home/agent/.config/dorbs/github-app.pkcs8.pem",
    "/home/agent/.config/dorbs/check-token",
    "/home/agent/.ssh",
    "/home/agent/dorbs-checker/data",
    "/run/user/1007/docker.sock",
    "/var/run/docker.sock",
  ]) {
    NodeAssert.equal(NodeFS.existsSync(path), false, path);
  }
  NodeAssert.deepEqual(NodeFS.readdirSync("/env").toSorted(), ["home", "repo"]);
});

test("resolves and reaches no host, the host's own addresses included", async () => {
  await NodeAssert.rejects(NodeDns.lookup("registry.npmjs.org"));
  await NodeAssert.rejects(fetch("https://1.1.1.1/"));
  for (const host of ["1.1.1.1", "10.0.2.2", "172.17.0.1", "169.254.169.254", "100.100.100.100"]) {
    await NodeAssert.rejects(connect(host, 443), host);
  }
});

test("writes nowhere but the environment and /tmp", () => {
  for (const path of ["/x", "/etc/x", "/usr/local/bin/x", "/root/x", "/home/x"]) {
    NodeAssert.throws(() => NodeFS.writeFileSync(path, "x"), path);
  }
  NodeFS.writeFileSync("/tmp/escape-probe", "allowed");
  NodeFS.writeFileSync("/env/home/escape-probe", "allowed");
});

test("holds no capability", () => {
  NodeAssert.match(NodeFS.readFileSync("/proc/self/status", "utf8"), /^CapEff:\s+0+$/m);
});
