// The only way out of the setup network: an HTTPS CONNECT proxy that reaches package registries and
// nothing else. It runs in a container of its own on both the setup network and the default bridge.
//   node egress.ts   listens on :3128; EGRESS_ALLOW is a comma-separated list, a leading dot for a domain.

import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

/** Package registries and the hosts their downloads redirect to. */
export const DEFAULT_ALLOW: ReadonlyArray<string> = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "dl.google.com",
  "nodejs.org",
  // uv's Python builds and git dependencies come from GitHub releases.
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "codeload.github.com",
];

/** Whether `host:port` is a listed host, or under a listed `.domain`, on an allowed port. */
export const isAllowed = (
  host: string,
  port: number,
  allow: ReadonlyArray<string>,
  ports: ReadonlyArray<number> = [443],
): boolean =>
  ports.includes(port) &&
  allow.some((entry) =>
    entry.startsWith(".") ? host.endsWith(entry) && host.length > entry.length : host === entry,
  );

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

/** The proxy server: tunnels allowed CONNECTs and refuses every other request. */
export const serveEgress = (allow: ReadonlyArray<string>, ports: ReadonlyArray<number> = [443]) => {
  const server = NodeHttp.createServer((request, response) => {
    log(`refused ${request.method} ${request.url}`);
    response.writeHead(403).end("Only HTTPS to package registries.\n");
  });
  server.on(
    "connect",
    (request: NodeHttp.IncomingMessage, client: NodeNet.Socket, head: Buffer) => {
      const target = /^([a-z0-9.-]+):(\d+)$/i.exec(request.url ?? "");
      const host = target?.[1]?.toLowerCase() ?? "";
      const port = Number(target?.[2]);
      if (target === null || !isAllowed(host, port, allow, ports)) {
        log(`refused CONNECT ${request.url}`);
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = NodeNet.createConnection({ host, port }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    },
  );
  return server;
};

if (process.argv[1]?.endsWith("egress.ts") === true) {
  const allow =
    process.env["EGRESS_ALLOW"]?.split(",").filter((entry) => entry !== "") ?? DEFAULT_ALLOW;
  serveEgress(allow).listen(3128, "0.0.0.0", () =>
    log(`egress proxy on :3128 for ${allow.join(", ")}`),
  );
}
