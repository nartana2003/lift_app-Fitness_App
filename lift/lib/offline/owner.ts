/**
 * Which account the local store belongs to. The local data (outbox, photos,
 * history) is not partitioned per user, so once a device has synced as user A
 * it must never upload or merge that data as user B (sign out A, sign in B on
 * the same browser). The first signed-in sync claims the device. A different
 * session user takes the device over automatically when nothing is unsent
 * (empty outbox, no dead letters, every photo backed up, no pending photo
 * deletes); otherwise it is refused and OWNER_MISMATCH_EVENT fires (SyncStatus
 * shows it). On a takeover the previous account's already-synced rows are
 * cleared from the device (BLK-04, see clearPreviousAccount).
 */
import { db } from "./db";
import { photoSignature } from "./remote";

// Same meta keys as sync.ts (DEAD_LETTER_KEY) and photoSync.ts (SYNCED_KEY,
// DELETED_KEY); literal here to avoid an import cycle. owner.test checks they match.
export const DEAD_KEY = "outbox:dead";
export const PHOTOS_SYNCED_KEY = "photos:synced";
export const PHOTOS_DELETED_KEY = "photos:deleted";
/** Same as sync.ts DISMISSED_KEY / RECENT_DELETES_KEY (literal: import cycle). */
export const DISMISSED_KEY = "outbox:dismissed";
export const RECENT_DELETES_KEY = "outbox:deleted";

/** True when nothing on this device still waits for the server (safe to hand to another account). */
async function nothingUnsent(): Promise<boolean> {
  if ((await db.outbox.count()) > 0) return false;
  const dead = (await db.meta.get(DEAD_KEY))?.value;
  if (Array.isArray(dead) && dead.length) return false;
  // Dismissed dead letters name rows that were never uploaded: still unsent.
  const dismissed = (await db.meta.get(DISMISSED_KEY))?.value;
  if (Array.isArray(dismissed) && dismissed.length) return false;
  const tomb = (await db.meta.get(PHOTOS_DELETED_KEY))?.value;
  if (Array.isArray(tomb) && tomb.length) return false;
  const synced = ((await db.meta.get(PHOTOS_SYNCED_KEY))?.value ?? {}) as Record<string, string>;
  for (const p of await db.photos.toArray()) if (synced[p.id] !== photoSignature(p)) return false;
  return true;
}

export const OWNER_KEY = "sync:owner";

/** Fired on window when sync is refused because another account signed in. */
export const OWNER_MISMATCH_EVENT = "lift:owner-mismatch";

/** Fired on window when the session account may sync this device (clears the mismatch banner). */
export const OWNER_OK_EVENT = "lift:owner-ok";

/**
 * meta keys that belong to the previous account and are dropped when another
 * account takes the device over (BLK-04): sync bookkeeping, the personal
 * profile, the Lyfta API key and exercise map, and everything that holds the
 * account's own ids or training data (renames, plateau state, split, goals,
 * favourites). Every meta key the app writes is in this list, in
 * ACCOUNT_META_PREFIXES, or in DEVICE_META_KEYS / DEVICE_META_PREFIXES (owner
 * test checks the source).
 */
export const ACCOUNT_META_KEYS = [
  DEAD_KEY,
  DISMISSED_KEY,
  RECENT_DELETES_KEY,
  PHOTOS_SYNCED_KEY,
  PHOTOS_DELETED_KEY,
  "photos:fails",
  "lastPull",
  "profile",
  "lyfta_key",
  "lyfta_map",
  "renames",
  "plateau_fix_applied",
  "plateau_dismissed",
  "split",
  "goals",
  "favorites",
] as const;

/** meta key prefixes cleared on takeover: monthly photo analyses, evidence-picks cache (built from the goals). */
export const ACCOUNT_META_PREFIXES = ["photo_analysis:", "evidence-picks:"] as const;

/**
 * meta keys KEPT on takeover: preferences of the device and the person holding
 * it, not of an account (unit, week start, theme, reminder times, the gym's
 * equipment, picks per muscle, rest timers) and the owner key itself.
 */
export const DEVICE_META_KEYS = ["settings", "reminders", "equipment", "today_picks_per_muscle", "default_rest_sec", "sync:owner"] as const;
export const DEVICE_META_PREFIXES = ["rest:"] as const;

/**
 * Remove the previous account's already-synced rows. Only called when nothing
 * is unsent, so everything removed here is safe on that account's server. The
 * in-progress workout (`active`) is not touched: it is the session the person
 * holding the device is in right now.
 */
async function clearPreviousAccount() {
  await Promise.all([
    db.workouts.clear(),
    db.workout_exercises.clear(),
    db.sets.clear(),
    db.measurements.clear(),
    db.photos.clear(),
    db.custom_exercises.clear(),
    db.routines.clear(),
    db.routine_exercises.clear(),
    db.planned_days.clear(),
  ]);
  await db.meta.bulkDelete([...ACCOUNT_META_KEYS]);
  for (const p of ACCOUNT_META_PREFIXES) await db.meta.where("key").startsWith(p).delete();
}

/**
 * True when `uid` may sync this device's data: it already owns it, or nobody
 * does yet (then it claims it). False for a different user. When a different
 * user takes the device over (nothing unsent), the previous account's synced
 * rows are cleared first, so the new account never sees or references them.
 */
export async function claimOwner(uid: string): Promise<boolean> {
  // Already the owner: a plain read, no write transaction.
  if ((await db.meta.get(OWNER_KEY))?.value === uid) {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new CustomEvent(OWNER_OK_EVENT));
    return true;
  }
  // No owner yet, or another one: decide in a small transaction.
  const quick = await db.transaction("rw", [db.meta, db.outbox, db.photos], async () => {
    const cur = (await db.meta.get(OWNER_KEY))?.value;
    if (typeof cur === "string" && cur === uid) return true;
    if (typeof cur === "string" && cur) return (await nothingUnsent()) ? "takeover" : false;
    await db.meta.put({ key: OWNER_KEY, value: uid });
    return true;
  });
  const ok = quick === "takeover" ? await takeOver(uid) : quick;
  // The previous account's rest timer goes too; the theme mirror is a device
  // preference (mirrored from the kept settings) and stays.
  if (quick === "takeover" && ok) clearAppLocalStorage(undefined, ["lift-theme"]);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(ok ? OWNER_OK_EVENT : OWNER_MISMATCH_EVENT));
  }
  return ok;
}

/** Another account takes the device over: re-check, clear the previous account's rows, claim. */
async function takeOver(uid: string): Promise<boolean> {
  const tables = [
    db.meta,
    db.outbox,
    db.photos,
    db.workouts,
    db.workout_exercises,
    db.sets,
    db.measurements,
    db.custom_exercises,
    db.routines,
    db.routine_exercises,
    db.planned_days,
  ];
  return db.transaction("rw", tables, async () => {
    const cur = (await db.meta.get(OWNER_KEY))?.value;
    if (typeof cur === "string" && cur === uid) return true;
    if (typeof cur === "string" && cur) {
      // Something may have been written since the quick check.
      if (!(await nothingUnsent())) return false;
      await clearPreviousAccount();
    }
    await db.meta.put({ key: OWNER_KEY, value: uid });
    return true;
  });
}

/** localStorage keys the app owns (rest timer, theme mirror). Literal to avoid importing client UI modules. */
export const APP_LOCAL_STORAGE_KEYS = ["lift:rest", "lift-theme"] as const;

/**
 * Remove every localStorage key the app owns: the known keys plus anything
 * under the "lift:" / "lift-" prefixes. Other sites' or libraries' keys are left
 * alone (Supabase clears its own session on sign-out). Never throws.
 */
export function clearAppLocalStorage(
  store: Pick<Storage, "length" | "key" | "removeItem"> | undefined = typeof localStorage !== "undefined" ? localStorage : undefined,
  except: readonly string[] = [],
): number {
  if (!store) return 0;
  try {
    const keys = new Set<string>(APP_LOCAL_STORAGE_KEYS);
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && (k.startsWith("lift:") || k.startsWith("lift-"))) keys.add(k);
    }
    for (const k of except) keys.delete(k);
    for (const k of keys) store.removeItem(k);
    return keys.size;
  } catch {
    return 0;
  }
}

/** The account that owns this device's data, or null. */
export async function getOwner(): Promise<string | null> {
  const v = (await db.meta.get(OWNER_KEY))?.value;
  return typeof v === "string" && v ? v : null;
}
