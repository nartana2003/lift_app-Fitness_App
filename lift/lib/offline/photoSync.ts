"use client";

/**
 * Cloud backup for progress photos. Photos stay local-first in Dexie
 * (db.photos); when Supabase is configured and the user is signed in, each
 * photo is uploaded to the private `progress-photos` bucket at
 * `<user id>/<photo id>.jpg` with a `progress_photos` row (pose, date, linked
 * workout). Photos on the server that this device lacks are downloaded, so a
 * new phone gets the gallery back.
 *
 * State in db.meta:
 * - "photos:synced": { [photo id]: signature } of what the server has, so a
 *   replaced Finish-screen photo (same id, new image) is uploaded again;
 * - "photos:deleted": ids deleted on this device (tombstones), removed on the
 *   server on the next run and never downloaded again;
 * - "photos:fails": per-photo upload failures, retried with growing backoff.
 *
 * Every step fails soft: an error leaves the photo for the next run. Runs only
 * for the account that owns this device's data (owner.ts).
 */

import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseConfigured } from "@/lib/supabase/configured";
import { db, type PhotoRow } from "./db";
import { claimOwner } from "./owner";
import { isOwnPhotoPath, PHOTO_BUCKET, photoPath, photoSignature, remotePhotoFromRow } from "./remote";

export const SYNCED_KEY = "photos:synced";
export const DELETED_KEY = "photos:deleted";
export const FAILS_KEY = "photos:fails";

/** Largest photo blob uploaded or accepted on download (local photos are already shrunk). */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** Backoff after `n` failed uploads of one photo: 1, 2, 4 ... minutes, at most a day. */
export const photoBackoffMs = (n: number) => Math.min(24 * 60, 2 ** Math.max(0, n - 1)) * 60_000;

type LocalPhoto = PhotoRow & { workout_id?: string };
type Fail = { n: number; next: number };

async function readMap(): Promise<Record<string, string>> {
  const v = (await db.meta.get(SYNCED_KEY))?.value;
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, string>) } : {};
}

async function readDeleted(): Promise<string[]> {
  const v = (await db.meta.get(DELETED_KEY))?.value;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

async function readFails(): Promise<Record<string, Fail>> {
  const v = (await db.meta.get(FAILS_KEY))?.value;
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, Fail>) } : {};
}

async function tombstone(id: string) {
  await db.transaction("rw", db.meta, async () => {
    const synced = await readMap();
    const deleted = await readDeleted();
    if (!deleted.includes(id)) deleted.push(id);
    delete synced[id];
    await db.meta.put({ key: SYNCED_KEY, value: synced });
    await db.meta.put({ key: DELETED_KEY, value: deleted });
  });
}

/**
 * Call after deleting a photo locally: the server copy is removed on the next
 * sync. Always leaves a tombstone, so an upload already in flight cannot bring
 * the photo back.
 */
export async function queuePhotoDelete(id: string): Promise<void> {
  await tombstone(id);
  void syncPhotos();
}

export type PhotoSyncResult = { uploaded: number; downloaded: number; deleted: number };

let running: Promise<PhotoSyncResult> | null = null;

/** Upload new or changed photos, delete removed ones, download missing ones. Never rejects. */
export function syncPhotos(): Promise<PhotoSyncResult> {
  if (running) return running;
  running = run()
    .catch(() => ({ uploaded: 0, downloaded: 0, deleted: 0 }))
    .finally(() => (running = null));
  return running;
}

/** True while the workout (or its exercises/sets) still waits in the outbox. */
async function workoutPending(workoutId: string): Promise<boolean> {
  const queue = await db.outbox.toArray();
  const weIds = new Set((await db.workout_exercises.where("workout_id").equals(workoutId).primaryKeys()) as string[]);
  return queue.some(
    (i) =>
      i.op === "upsert" &&
      ((i.table === "workouts" && i.row.id === workoutId) ||
        (i.table === "workout_exercises" && i.row.workout_id === workoutId) ||
        (i.table === "sets" && weIds.has(i.row.workout_exercise_id as string))),
  );
}

type Client = ReturnType<typeof supabaseBrowser>;

/**
 * The workout link to send, "wait" to retry later, or null. A workout that is
 * not on this device is kept when the server has it, and dropped only when it
 * is confirmed gone (a queued delete, or absent on the server).
 */
async function workoutLink(supabase: Client, workoutId: string | null): Promise<string | null | "wait"> {
  if (!workoutId) return null;
  if (await workoutPending(workoutId)) return "wait";
  if (await db.workouts.get(workoutId)) return workoutId;
  const queuedDelete = (await db.outbox.toArray()).some((i) => i.table === "workouts" && i.op === "delete" && i.row.id === workoutId);
  if (queuedDelete) return null;
  const { data, error } = await supabase.from("workouts").select("id").eq("id", workoutId);
  if (error || !Array.isArray(data)) return "wait";
  return data.length ? workoutId : null;
}

async function run(): Promise<PhotoSyncResult> {
  const result: PhotoSyncResult = { uploaded: 0, downloaded: 0, deleted: 0 };
  if (!supabaseConfigured) return result;
  if (typeof navigator !== "undefined" && !navigator.onLine) return result;
  const supabase = supabaseBrowser();
  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user.id;
  if (!uid || !(await claimOwner(uid))) return result;
  const bucket = supabase.storage.from(PHOTO_BUCKET);

  // 1. Remote deletes (tombstones). Removing a missing object or row is a no-op.
  for (const id of await readDeleted()) {
    if (await db.photos.get(id)) {
      // Restored locally (e.g. from a backup): keep it and drop the tombstone.
      await db.transaction("rw", db.meta, async () => {
        await db.meta.put({ key: DELETED_KEY, value: (await readDeleted()).filter((x) => x !== id) });
      });
      continue;
    }
    const { error: rmErr } = await bucket.remove([photoPath(uid, id)]);
    if (rmErr) continue;
    const { error } = await supabase.from("progress_photos").delete().eq("id", id);
    if (error) continue;
    await db.transaction("rw", db.meta, async () => {
      await db.meta.put({ key: DELETED_KEY, value: (await readDeleted()).filter((x) => x !== id) });
    });
    result.deleted++;
  }

  // 2. Uploads.
  const local = (await db.photos.toArray()) as LocalPhoto[];
  const now = Date.now();
  for (const p of local) {
    const sig = photoSignature(p);
    if ((await readMap())[p.id] === sig) continue;
    if (!(p.blob instanceof Blob) || p.blob.size === 0 || p.blob.size > MAX_PHOTO_BYTES) continue;
    const fail = (await readFails())[p.id];
    if (fail && fail.next > now) continue;
    // The server row references workouts(id): wait until that workout is uploaded.
    const link = await workoutLink(supabase, p.workout_id ?? null);
    if (link === "wait") continue;

    const path = photoPath(uid, p.id);
    const { error: upErr } = await bucket.upload(path, p.blob, { upsert: true, contentType: p.blob.type || "image/jpeg" });
    const { error } = upErr
      ? { error: upErr }
      : await supabase.from("progress_photos").upsert({ id: p.id, taken_at: p.taken_at, pose: p.pose, storage_path: path, workout_id: link });
    await db.transaction("rw", db.meta, async () => {
      const fails = await readFails();
      if (error) {
        const n = (fails[p.id]?.n ?? 0) + 1;
        fails[p.id] = { n, next: now + photoBackoffMs(n) };
      } else delete fails[p.id];
      await db.meta.put({ key: FAILS_KEY, value: fails });
    });
    if (error) continue;
    // Deleted while uploading: tombstone it so the next run removes the copy.
    if (!(await db.photos.get(p.id)) || (await readDeleted()).includes(p.id)) {
      await tombstone(p.id);
      continue;
    }
    await db.transaction("rw", db.meta, async () => {
      const m = await readMap();
      m[p.id] = sig;
      await db.meta.put({ key: SYNCED_KEY, value: m });
    });
    result.uploaded++;
  }

  // 3. Downloads (photos taken on another device).
  const { data: rows, error } = await supabase.from("progress_photos").select("id, taken_at, pose, storage_path, workout_id");
  if (error || !Array.isArray(rows)) return result;
  const have = new Set((await db.photos.toCollection().primaryKeys()) as string[]);
  const deleted = new Set(await readDeleted());
  for (const raw of rows as Record<string, unknown>[]) {
    const r = remotePhotoFromRow(uid, raw);
    if (!r || have.has(r.id) || deleted.has(r.id) || !isOwnPhotoPath(uid, r.storage_path)) continue;
    const { data: blob, error: dlErr } = await bucket.download(r.storage_path);
    if (dlErr || !(blob instanceof Blob) || blob.size === 0 || blob.size > MAX_PHOTO_BYTES) continue;
    const row: LocalPhoto = { id: r.id, taken_at: r.taken_at, pose: r.pose, blob };
    if (r.workout_id) row.workout_id = r.workout_id;
    const added = await db.transaction("rw", db.photos, db.meta, async () => {
      if (await db.photos.get(r.id)) return false;
      if ((await readDeleted()).includes(r.id)) return false; // deleted while downloading
      await db.photos.put(row);
      const m = await readMap();
      m[r.id] = photoSignature(row);
      await db.meta.put({ key: SYNCED_KEY, value: m });
      return true;
    });
    if (added) result.downloaded++;
  }
  return result;
}
