import type { SQLiteWorkspaceProvider } from "@cloudflare/computer";
import { create, VirtualProvider } from "@platformatic/vfs";

import type { FsPromises } from "./layered.ts";

/**
 * The session VFS as node fs promises, built as Computer's git client builds it for isomorphic-git, so files the
 * session writes report the stats Computer's git expects. Computer does not export its own.
 */

// The provider methods Computer's adapter forwards; a method added to the provider later stays out until listed.
const FORWARDED = [
  "open",
  "openSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "readdir",
  "readdirSync",
  "mkdir",
  "mkdirSync",
  "rmdir",
  "rmdirSync",
  "unlink",
  "unlinkSync",
  "rename",
  "renameSync",
  "readFile",
  "readFileSync",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "exists",
  "existsSync",
  "copyFile",
  "copyFileSync",
  "internalModuleStat",
  "realpath",
  "realpathSync",
  "access",
  "accessSync",
  "readlink",
  "readlinkSync",
  "symlink",
  "symlinkSync",
  "watch",
  "watchAsync",
  "watchFile",
  "unwatchFile",
  "closeSync",
  "readSync",
  "writeSync",
  "fstatSync",
  "truncateSync",
  "ftruncateSync",
] as const;

class SessionProvider extends VirtualProvider {
  readonly inner: SQLiteWorkspaceProvider;

  constructor(inner: SQLiteWorkspaceProvider) {
    super();
    this.inner = inner;
  }

  override get readonly() {
    return this.inner.readonly;
  }

  override get supportsSymlinks() {
    return this.inner.supportsSymlinks;
  }

  override get supportsWatch() {
    return this.inner.supportsWatch;
  }
}

for (const name of FORWARDED) {
  Object.defineProperty(SessionProvider.prototype, name, {
    value(this: SessionProvider, ...args: unknown[]) {
      const method: unknown = Reflect.get(this.inner, name);
      if (typeof method !== "function")
        throw new Error(`SQLiteWorkspaceProvider.${name} is not a function`);
      return method.apply(this.inner, args);
    },
    writable: true,
    configurable: true,
  });
}

export const overlayFs = (provider: SQLiteWorkspaceProvider): FsPromises =>
  create(new SessionProvider(provider), { moduleHooks: false }).promises;
