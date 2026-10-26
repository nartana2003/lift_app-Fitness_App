/**
 * Which account the local store belongs to. The local data (outbox, photos,
 * history) is not partitioned per user, so once a device has synced as user A
 * it must never upload or merge that data as user B (sign out A, sign in B on
 * the same browser). The first signed-in sync claims the device; a different
 * session user is then refused until the local data is cleared.
 */
import { db } from "./db";

export const OWNER_KEY = "sync:owner";

/** Fired on window when sync is refused because another account signed in. */
export const OWNER_MISMATCH_EVENT = "lift:owner-mismatch";

/**
 * True when `uid` may sync this device's data: it already owns it, or nobody
 * does yet (then it claims it). False for a different user.
 */
export async function claimOwner(uid: string): Promise<boolean> {
  const ok = await db.transaction("rw", db.meta, async () => {
    const cur = (await db.meta.get(OWNER_KEY))?.value;
    if (typeof cur === "string" && cur) return cur === uid;
    await db.meta.put({ key: OWNER_KEY, value: uid });
    return true;
  });
  if (!ok && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(OWNER_MISMATCH_EVENT));
  }
  return ok;
}

/** The account that owns this device's data, or null. */
export async function getOwner(): Promise<string | null> {
  const v = (await db.meta.get(OWNER_KEY))?.value;
  return typeof v === "string" && v ? v : null;
}
