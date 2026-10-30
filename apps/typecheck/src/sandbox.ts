import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// What dyld, the npm launcher shims and Node load from.
const SYSTEM = [
  "/usr/lib",
  "/usr/share",
  "/usr/bin",
  "/bin",
  "/System",
  "/Library/Apple",
  "/private/var/db/dyld",
  "/dev",
];

const quoted = (path: string) => `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * The directories tsrs and oxlint load from on this machine: the npm launchers and packages in
 * this workspace, and Node with the Homebrew libraries it links.
 */
export const toolchainPaths = (): ReadonlyArray<string> => {
  const node = NodeFS.realpathSync(process.execPath);
  const cellar = node.indexOf("/Cellar/");
  return [
    NodePath.resolve(import.meta.dirname, "../node_modules"),
    NodePath.resolve(import.meta.dirname, "../../../node_modules"),
    ...(cellar === -1
      ? [NodePath.dirname(NodePath.dirname(node))]
      : [node.slice(0, cellar + "/Cellar".length), `${node.slice(0, cellar)}/opt`]),
  ].map((path) => NodeFS.realpathSync(path));
};

/**
 * A macOS sandbox profile for `sandbox-exec -p`: the process may read `reads` and the system,
 * write `writes`, and see any file's metadata, which tells it only that the file exists.
 */
export const sandboxProfile = (
  reads: ReadonlyArray<string>,
  writes: ReadonlyArray<string>,
): string =>
  [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    // Node's startup looks up launchd services (logd, libinfo, notifyd). Denied, a lookup can hang
    // rather than fail. The tools run no client code, so the boundary that matters is files.
    "(allow mach-lookup)",
    '(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))',
    `(allow file-read* (literal "/") ${[...SYSTEM, ...reads].map((path) => `(subpath ${quoted(path)})`).join(" ")})`,
    `(allow file-write* (literal "/dev/null") ${writes.map((path) => `(subpath ${quoted(path)})`).join(" ")})`,
  ].join("\n");
