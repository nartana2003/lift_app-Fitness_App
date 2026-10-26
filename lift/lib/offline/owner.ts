/**
 * Which account the local store belongs to. The local data (outbox, photos,
 * history) is not partitioned per user, so once a device has synced as user A
 * it must never upload or merge that data as user B (sign out A, sign in B on
 * the same browser). The first signed-in sync claims the device. A different
 * session user takes the device over automatically when nothing is unsent
 * (empty outbox, no dead letters, every photo backed up, no pending photo
 * deletes); otherwise it is refused and OWNER_MISMATCH_EVENT fires (SyncStatus
 * shows it). The previous account's already-synced rows stay on the device
 * until the user erases local data.
 */
import { db } from "./db";
import { photoSignature } from "./remote";

// Same meta keys as sync.ts (DEAD_LETTER_KEY) and photoSync.ts (SYNCED_KEY,
// DELETED_KEY); literal here to avoid an import cycle. owner.test checks they match.
export const DEAD_KEY = "outbox:dead";
export const PHOTOS_SYNCED_KEY = "photos:synced";
export const PHOTOS_DELETED_KEY = "photos:deleted";

/** True when nothing on this device still waits for the server (safe to hand to another account). */
async function nothingUnsent(): Promise<boolean> {
  if ((await db.outbox.count()) > 0) return false;
  const dead = (await db.meta.get(DEAD_KEY))?.value;
  if (Array.isArray(dead) && dead.length) return false;
  const tomb = (await db.meta.get(PHOTOS_DELETED_KEY))?.value;
  if (Array.isArray(tomb) && tomb.length) return false;
  const synced = ((await db.meta.get(PHOTOS_SYNCED_KEY))?.value ?? {}) as Record<string, string>;
  for (const p of await db.photos.toArray()) if (synced[p.id] !== photoSignature(p)) return false;
  return true;
}

export const OWNER_KEY = "sync:owner";

/** Fired on window when sync is refused because another account signed in. */
export const OWNER_MISMATCH_EVENT = "lift:owner-mismatch";

/**
 * True when `uid` may sync this device's data: it already owns it, or nobody
 * does yet (then it claims it). False for a different user.
 */
export async function claimOwner(uid: string): Promise<boolean> {
  const ok = await db.transaction("rw", [db.meta, db.outbox, db.photos], async () => {
    const cur = (await db.meta.get(OWNER_KEY))?.value;
    if (typeof cur === "string" && cur === uid) return true;
    if (typeof cur === "string" && cur && !(await nothingUnsent())) return false;
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
