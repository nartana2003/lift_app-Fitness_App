"use client";

import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseConfigured } from "@/lib/supabase/configured";
import { db, type OutboxItem, type SetRow, type SyncTable, type WorkoutExerciseRow, type WorkoutRow } from "./db";

const now = () => new Date().toISOString();

/** Queue local writes (already applied to Dexie) for upload. */
export async function enqueue(items: Omit<OutboxItem, "created_at" | "seq">[]) {
  await db.outbox.bulkAdd(items.map((i) => ({ ...i, created_at: now() })));
  void flush();
}

let flushing: Promise<number> | null = null;

/**
 * Push the outbox in order. Upserts use client-generated UUIDs, so re-sending
 * after a dropped connection never creates duplicates.
 */
export function flush(): Promise<number> {
  if (flushing) return flushing;
  flushing = (async () => {
    if (!supabaseConfigured) return 0;
    if (typeof navigator !== "undefined" && !navigator.onLine) return 0;
    const supabase = supabaseBrowser();
    const { data } = await supabase.auth.getSession();
    if (!data.session) return 0;

    const uid = data.session.user.id;
    let sent = 0;
    for (;;) {
      const item = await db.outbox.orderBy("seq").first();
      if (!item) break;
      const q = supabase.from(item.table);
      // A user's own exercises are rows in the shared `exercises` table, owned by them.
      const row = item.table === "exercises" ? { ...item.row, owner_id: uid } : item.row;
      const { error } =
        item.op === "upsert" ? await q.upsert(row) : await q.delete().eq("id", item.row.id as string);
      if (error) {
        console.warn("sync failed, will retry", item.table, error.message);
        break;
      }
      await db.outbox.delete(item.seq!);
      sent++;
    }
    if (sent) window.dispatchEvent(new CustomEvent("lift:synced", { detail: sent }));
    return sent;
  })().finally(() => (flushing = null));
  return flushing;
}

export async function pendingCount() {
  return db.outbox.count();
}

/** Pull the user's recent history from Supabase into the local store. */
export async function pull(days = 365) {
  if (!supabaseConfigured || !navigator.onLine) return;
  await flush(); // never overwrite unsent local edits
  if ((await db.outbox.count()) > 0) return;

  const supabase = supabaseBrowser();
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data, error } = await supabase
    .from("workouts")
    .select("id, started_at, ended_at, notes, routine_id, workout_exercises(id, workout_id, exercise_id, position, sets(id, workout_exercise_id, set_no, reps, weight, is_warmup, rir, completed_at))")
    .gte("started_at", since)
    .order("started_at", { ascending: false });
  if (error || !data) return;

  type Pulled = WorkoutRow & { workout_exercises: (WorkoutExerciseRow & { sets: SetRow[] })[] };
  const ws: WorkoutRow[] = [];
  const wes: WorkoutExerciseRow[] = [];
  const ss: SetRow[] = [];
  for (const w of data as Pulled[]) {
    const { workout_exercises, ...wr } = w;
    ws.push(wr);
    for (const we of workout_exercises) {
      const { sets, ...wer } = we;
      wes.push(wer);
      ss.push(...sets.map((s) => ({ ...s, weight: Number(s.weight) })));
    }
  }
  await db.transaction("rw", db.workouts, db.workout_exercises, db.sets, async () => {
    const localIds = (await db.workouts.where("started_at").aboveOrEqual(since).primaryKeys()) as string[];
    const remote = new Set(ws.map((w) => w.id));
    const removed = localIds.filter((id) => !remote.has(id));
    if (removed.length) await deleteWorkoutsLocal(removed);
    await db.workouts.bulkPut(ws);
    await db.workout_exercises.bulkPut(wes);
    await db.sets.bulkPut(ss);
  });
  await db.meta.put({ key: "lastPull", value: now() });
}

async function deleteWorkoutsLocal(ids: string[]) {
  const wes = await db.workout_exercises.where("workout_id").anyOf(ids).toArray();
  await db.sets.where("workout_exercise_id").anyOf(wes.map((w) => w.id)).delete();
  await db.workout_exercises.bulkDelete(wes.map((w) => w.id));
  await db.workouts.bulkDelete(ids);
}

/** Delete a workout locally and remotely (cascade on the server). */
export async function deleteWorkout(id: string) {
  await db.transaction("rw", db.workouts, db.workout_exercises, db.sets, () => deleteWorkoutsLocal([id]));
  // Drop any queued uploads for it, then queue the delete.
  const wes = new Set<string>();
  for (const item of await db.outbox.toArray()) {
    if (item.table === "workout_exercises" && item.row.workout_id === id) wes.add(item.row.id as string);
  }
  await db.outbox
    .filter(
      (i) =>
        (i.table === "workouts" && i.row.id === id) ||
        (i.table === "workout_exercises" && i.row.workout_id === id) ||
        (i.table === "sets" && wes.has(i.row.workout_exercise_id as string)),
    )
    .delete();
  await enqueue([{ table: "workouts" as SyncTable, op: "delete", row: { id } }]);
}

/** Start background syncing: on load, when connectivity returns, and periodically. */
export function startSync() {
  void pull();
  window.addEventListener("online", () => void flush().then(() => pull()));
  const t = setInterval(() => void flush(), 30_000);
  return () => clearInterval(t);
}
