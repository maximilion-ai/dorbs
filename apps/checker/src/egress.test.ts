import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { isAllowed, serveEgress } from "./egress.ts";

const ALLOW = ["registry.npmjs.org", ".pythonhosted.org", "localhost"];

it("allows only listed hosts on port 443, or a listed domain's subdomains", () => {
  assert.isTrue(isAllowed("registry.npmjs.org", 443, ALLOW));
  assert.isTrue(isAllowed("files.pythonhosted.org", 443, ALLOW));
  assert.isFalse(isAllowed("pythonhosted.org.evil.example", 443, ALLOW));
  assert.isFalse(isAllowed("registry.npmjs.org", 22, ALLOW));
  assert.isFalse(isAllowed("169.254.169.254", 443, ALLOW));
  assert.isFalse(isAllowed("evil.example", 443, ALLOW));
});

const portOf = (server: NodeNet.Server): number => {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};

/** Sends a CONNECT through the proxy and answers its status line. */
const connect = (proxyPort: number, target: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port: proxyPort }, () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.once("data", (chunk) => {
      resolve(chunk.toString().split("\r\n")[0] ?? "");
      socket.destroy();
    });
    socket.once("error", reject);
  });

it.live("tunnels a CONNECT to an allowed host and refuses the rest, plain HTTP included", () =>
  Effect.promise(async () => {
    const upstream = NodeNet.createServer((socket) => socket.end("hello"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = portOf(upstream);
    const proxy = serveEgress(["localhost"], [upstreamPort]);
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = portOf(proxy);
    try {
      assert.strictEqual(
        await connect(proxyPort, `localhost:${upstreamPort}`),
        "HTTP/1.1 200 Connection Established",
      );
      assert.strictEqual(
        await connect(proxyPort, `example.com:${upstreamPort}`),
        "HTTP/1.1 403 Forbidden",
      );
      const plain = await new Promise<number | undefined>((resolve) =>
        NodeHttp.get(
          { host: "127.0.0.1", port: proxyPort, path: "http://localhost/" },
          (response) => {
            resolve(response.statusCode);
            response.resume();
          },
        ),
      );
      assert.strictEqual(plain, 403);
    } finally {
      proxy.close();
      upstream.close();
    }
  }),
);
