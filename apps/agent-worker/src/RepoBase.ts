import { DurableObject } from "cloudflare:workers";

/**
 * One per base (repo at a commit): hands out the lease to build it, so a hundred sessions that clone one commit at
 * once fetch it from origin once, and deletes the base a while after its last use.
 */

// A builder renews its lease while it fetches; one silent this long has died, and another may take over.
const LEASE_MS = 2 * 60 * 1000;
const UNUSED_MS = 14 * 24 * 60 * 60 * 1000;

type Lease = { readonly holder: string; readonly at: number };

export class RepoBase extends DurableObject {
  /** Grants or renews the build lease for `holder`; false while another holder's lease is live or the base is being deleted. */
  lease(holder: string): boolean {
    const now = Date.now();
    if (this.ctx.storage.kv.get<boolean>("deleting") === true) return false;
    const current = this.ctx.storage.kv.get<Lease>("lease");
    if (current !== undefined && current.holder !== holder && now - current.at < LEASE_MS)
      return false;
    this.ctx.storage.kv.put("lease", { holder, at: now });
    return true;
  }

  release(holder: string): void {
    if (this.ctx.storage.kv.get<Lease>("lease")?.holder === holder)
      this.ctx.storage.kv.delete("lease");
  }

  /** Records a use of the base at `prefix`; its deletion waits UNUSED_MS from the last one. */
  async used(prefix: string): Promise<void> {
    const now = Date.now();
    const last = this.ctx.storage.kv.get<number>("used");
    // Renewing more often than hourly only costs writes.
    if (last !== undefined && now - last < 60 * 60 * 1000) return;
    this.ctx.storage.kv.put("used", now);
    this.ctx.storage.kv.put("prefix", prefix);
    await this.ctx.storage.setAlarm(now + UNUSED_MS);
  }

  override async alarm(): Promise<void> {
    const prefix = this.ctx.storage.kv.get<string>("prefix");
    const last = this.ctx.storage.kv.get<number>("used") ?? 0;
    if (Date.now() - last < UNUSED_MS) {
      await this.ctx.storage.setAlarm(last + UNUSED_MS);
      return;
    }
    if (prefix !== undefined) {
      // No build starts until the deletion ends, so none writes a part this deletes.
      this.ctx.storage.kv.put("deleting", true);
      // The manifest first, so no session trusts a base that is half deleted.
      await this.env.Bases.delete(`${prefix}/manifest.json`);
      let cursor: string | undefined;
      do {
        const listed = await this.env.Bases.list({
          prefix: `${prefix}/`,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (listed.objects.length > 0)
          await this.env.Bases.delete(listed.objects.map((object) => object.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor !== undefined);
    }
    // A session that used the base while it went rebuilds it, and its use stays on record.
    if ((this.ctx.storage.kv.get<number>("used") ?? 0) !== last) {
      this.ctx.storage.kv.delete("deleting");
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}
