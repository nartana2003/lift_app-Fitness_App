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
 * - "photos:deleted": ids deleted on this device and still to delete remotely.
 *
 * Every step fails soft: an error leaves the photo for the next run.
 */

import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseConfigured } from "@/lib/supabase/configured";
import { db, type PhotoRow } from "./db";
import { isOwnPhotoPath, PHOTO_BUCKET, photoPath, photoSignature, remotePhotoFromRow } from "./remote";

export const SYNCED_KEY = "photos:synced";
export const DELETED_KEY = "photos:deleted";

/** Largest photo blob uploaded or accepted on download (local photos are already shrunk). */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

type LocalPhoto = PhotoRow & { workout_id?: string };

async function readMap(): Promise<Record<string, string>> {
  const v = (await db.meta.get(SYNCED_KEY))?.value;
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, string>) } : {};
}

async function readDeleted(): Promise<string[]> {
  const v = (await db.meta.get(DELETED_KEY))?.value;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Call after deleting a photo locally: the server copy is removed on the next sync. */
export async function queuePhotoDelete(id: string): Promise<void> {
  await db.transaction("rw", db.meta, async () => {
    const synced = await readMap();
    const deleted = await readDeleted();
    if (synced[id] !== undefined && !deleted.includes(id)) deleted.push(id);
    delete synced[id];
    await db.meta.put({ key: SYNCED_KEY, value: synced });
    await db.meta.put({ key: DELETED_KEY, value: deleted });
  });
  void syncPhotos();
}

export type PhotoSyncResult = { uploaded: number; downloaded: number; deleted: number };

let running: Promise<PhotoSyncResult> | null = null;

/** Upload new or changed photos, delete removed ones, download missing ones. */
export function syncPhotos(): Promise<PhotoSyncResult> {
  if (running) return running;
  running = run().finally(() => (running = null));
  return running;
}

async function run(): Promise<PhotoSyncResult> {
  const result: PhotoSyncResult = { uploaded: 0, downloaded: 0, deleted: 0 };
  if (!supabaseConfigured) return result;
  if (typeof navigator !== "undefined" && !navigator.onLine) return result;
  const supabase = supabaseBrowser();
  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user.id;
  if (!uid) return result;
  const bucket = supabase.storage.from(PHOTO_BUCKET);

  // 1. Remote deletes.
  for (const id of await readDeleted()) {
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
  const pendingWorkouts = new Set(
    (await db.outbox.toArray()).filter((i) => i.table === "workouts" && i.op === "upsert").map((i) => i.row.id as string),
  );
  const local = (await db.photos.toArray()) as LocalPhoto[];
  for (const p of local) {
    const sig = photoSignature(p);
    if ((await readMap())[p.id] === sig) continue;
    if (!(p.blob instanceof Blob) || p.blob.size === 0 || p.blob.size > MAX_PHOTO_BYTES) continue;
    // The server row references workouts(id): wait until that workout is uploaded,
    // and drop the link when the workout no longer exists on this device.
    let workoutId: string | null = p.workout_id ?? null;
    if (workoutId && pendingWorkouts.has(workoutId)) continue;
    if (workoutId && !(await db.workouts.get(workoutId))) workoutId = null;

    const path = photoPath(uid, p.id);
    const { error: upErr } = await bucket.upload(path, p.blob, { upsert: true, contentType: p.blob.type || "image/jpeg" });
    if (upErr) continue;
    const { error } = await supabase
      .from("progress_photos")
      .upsert({ id: p.id, taken_at: p.taken_at, pose: p.pose, storage_path: path, workout_id: workoutId });
    if (error) continue;
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
    await db.transaction("rw", db.photos, db.meta, async () => {
      if (await db.photos.get(r.id)) return;
      await db.photos.put(row);
      const m = await readMap();
      m[r.id] = photoSignature(row);
      await db.meta.put({ key: SYNCED_KEY, value: m });
    });
    result.downloaded++;
  }
  return result;
}
