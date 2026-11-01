import { type Base, basePrefix, buildBase, forgetBase, latestBase, openBase } from "./base.ts";
import { head, type Origin } from "./clone.ts";
import type { LayeredFs } from "./layered.ts";

const writeRef = async (fs: LayeredFs, path: string, text: string) => {
  await fs.promises.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await fs.promises.writeFile(path, text);
};

/** Where clone_repo keeps bases, and how sessions agree on who builds one. */
export type BaseStore = {
  readonly bucket: R2Bucket;
  readonly lease: (prefix: string) => {
    lease(holder: string): Promise<boolean>;
    release(holder: string): Promise<void>;
    used(prefix: string): Promise<boolean>;
  };
};

// While another session builds a base, a waiting one looks for its manifest this often.
const WAIT_MS = 3000;
// A builder renews its lease this often; RepoBase lets another take over after two minutes of silence.
const RENEW_MS = 30_000;

/** Puts off deleting `base` and the bases whose parts it reads; false once any of their deletions has begun. */
export const keepBase = async (store: BaseStore, base: Base): Promise<boolean> => {
  for (const prefix of [base.prefix, ...base.manifest.uses])
    if (!(await store.lease(prefix).used(prefix))) return false;
  return true;
};

/** The repo's latest base, whose parts a new base may read, unless it or a base it reads is being deleted. */
const parentOf = async (store: BaseStore, repo: string): Promise<Base | undefined> => {
  const latest = await latestBase(store.bucket, repo);
  const parent = latest === undefined ? undefined : await openBase(store.bucket, latest);
  return parent !== undefined && (await keepBase(store, parent)) ? parent : undefined;
};

/** The base of `repo` at `commit`, built by this session under the lease or waited for while another builds it. */
const ensureBase = async (
  store: BaseStore,
  origin: Origin,
  repo: string,
  commit: string,
  holder: string,
): Promise<string> => {
  const prefix = basePrefix(repo, commit);
  const lease = store.lease(prefix);
  for (;;) {
    const base = await openBase(store.bucket, prefix);
    if (base !== undefined) {
      if (await keepBase(store, base)) return prefix;
      // RepoBase is deleting it; once it is gone, a builder makes it again.
      forgetBase(prefix);
    } else if (await lease.lease(holder)) {
      // The deletion clock starts with the build, so the parts of one that never finishes go too.
      await lease.used(prefix);
      const renew = setInterval(() => void lease.lease(holder).catch(() => undefined), RENEW_MS);
      try {
        await buildBase(store.bucket, origin, repo, commit, await parentOf(store, repo));
      } finally {
        clearInterval(renew);
        await lease.release(holder);
      }
      continue;
    }
    await scheduler.wait(WAIT_MS);
  }
};

/**
 * Clones origin's HEAD into `dir`: makes sure the repo's base at that commit exists, then writes only the git
 * metadata a working repo needs into the session's overlay. Every file reads through to the base.
 */
export const cloneRepo = async (
  fs: LayeredFs,
  store: BaseStore,
  origin: Origin,
  repo: string,
  dir: string,
  holder: string,
): Promise<{ readonly commit: string; readonly branch: string; readonly base: string }> => {
  // A clone a restart cut off starts over.
  fs.reset();
  await fs.promises.rm?.(dir, { recursive: true, force: true });
  const { commit, branch } = await head(origin);
  const base = await ensureBase(store, origin, repo, commit, holder);
  const manifest = (await openBase(store.bucket, base))?.manifest;
  const gitDir = `${dir}/.git`;
  await fs.promises.mkdir(`${gitDir}/objects/pack`, { recursive: true });
  await fs.promises.mkdir(`${gitDir}/refs/tags`, { recursive: true });
  await writeRef(fs, `${gitDir}/HEAD`, `ref: refs/heads/${branch}\n`);
  await writeRef(fs, `${gitDir}/refs/heads/${branch}`, `${commit}\n`);
  await writeRef(fs, `${gitDir}/refs/remotes/origin/${branch}`, `${commit}\n`);
  await writeRef(fs, `${gitDir}/refs/remotes/origin/HEAD`, `ref: refs/remotes/origin/${branch}\n`);
  if ((manifest?.shallow.length ?? 0) > 0)
    await writeRef(fs, `${gitDir}/shallow`, `${manifest?.shallow.join("\n")}\n`);
  await writeRef(
    fs,
    `${gitDir}/config`,
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n" +
      `[remote "origin"]\n\turl = ${origin.url}\n\tfetch = +refs/heads/${branch}:refs/remotes/origin/${branch}\n` +
      `[branch "${branch}"]\n\tremote = origin\n\tmerge = refs/heads/${branch}\n`,
  );
  return { commit, branch, base };
};
