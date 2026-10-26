"use client";

import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseConfigured } from "@/lib/supabase/configured";
import { customExerciseFromRemote, dedupePlannedDays, measurementFromRemote, plannedDayFromRemote, routineExerciseFromRemote, routineFromRemote, toRemoteRow } from "./remote";
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
      // toRemoteRow also makes planned_days.was_marked and routines.split_day_id explicit.
      const row = toRemoteRow(item.table, item.row, uid);
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
  await pullTables();
}

type Client = ReturnType<typeof supabaseBrowser>;

async function selectAll(supabase: Client, table: string, columns: string, filter?: (q: ReturnType<ReturnType<Client["from"]>["select"]>) => unknown) {
  const base = supabase.from(table).select(columns);
  const q = (filter ? filter(base) : base) as PromiseLike<{ data: unknown; error: unknown }>;
  const { data, error } = await q;
  return !error && Array.isArray(data) ? (data as Record<string, unknown>[]) : null;
}

const clean = <T>(rows: Record<string, unknown>[] | null, map: (r: Record<string, unknown>) => T | null): T[] | null =>
  rows ? rows.map(map).filter((x): x is T => x !== null) : null;

/**
 * Sync across devices for the rest of the local store: the user's planned days,
 * routines (+ their exercises), measurements and custom exercises.
 *
 * Upsert only: rows on the server are written locally, local rows are never
 * deleted here (a delete made on another device does not remove a row on this
 * one). Runs only with an empty outbox, so it never overwrites unsent edits.
 * A table that fails to load is skipped, the others still apply.
 */
export async function pullTables(): Promise<void> {
  if (!supabaseConfigured || !navigator.onLine) return;
  if ((await db.outbox.count()) > 0) return;
  const supabase = supabaseBrowser();
  const { data: auth } = await supabase.auth.getSession();
  const uid = auth.session?.user.id;
  if (!uid) return;

  const [planned, routines, routineExercises, measurements, custom] = await Promise.all([
    selectAll(supabase, "planned_days", "id, date, routine_id, status, workout_id, skip_reason, skip_note, moved_to, moved_from, was_marked, created_at"),
    selectAll(supabase, "routines", "id, name, day_label, source, kind, source_url, platform, thumbnail_url, creator, notes, created_at, split_day_id"),
    selectAll(supabase, "routine_exercises", "id, routine_id, exercise_id, position, target_sets, target_reps"),
    selectAll(supabase, "measurements", "id, type, value, date"),
    selectAll(supabase, "exercises", "id, name, muscle_groups, secondary_groups, equipment, category, mechanic, force, level, instructions, image_urls, tiktok_url, video_url", (q) =>
      q.eq("owner_id", uid),
    ),
  ]);

  const days = clean(planned, plannedDayFromRemote);
  const rs = clean(routines, routineFromRemote);
  const res = clean(routineExercises, routineExerciseFromRemote);
  const ms = clean(measurements, measurementFromRemote);
  const cs = clean(custom, customExerciseFromRemote);

  await db.transaction("rw", [db.planned_days, db.routines, db.routine_exercises, db.measurements, db.custom_exercises, db.outbox], async () => {
    // Re-check inside the transaction: a write may have been queued meanwhile.
    if ((await db.outbox.count()) > 0) return;
    if (days) {
      const unique = dedupePlannedDays(days);
      // planned_days has a unique local `date`: drop a local row with another id on the same date first.
      const clash = await db.planned_days.where("date").anyOf(unique.map((d) => d.date)).toArray();
      const ids = new Set(unique.map((d) => d.id));
      await db.planned_days.bulkDelete(clash.filter((c) => !ids.has(c.id)).map((c) => c.id));
      await db.planned_days.bulkPut(unique);
    }
    if (rs) await db.routines.bulkPut(rs);
    if (res) await db.routine_exercises.bulkPut(res);
    if (ms) {
      // One entry per type per day locally: the server row replaces a local one with another id.
      for (const m of ms) {
        const same = await db.measurements.where("[type+date]").equals([m.type, m.date]).toArray();
        await db.measurements.bulkDelete(same.filter((x) => x.id !== m.id).map((x) => x.id));
      }
      await db.measurements.bulkPut(ms);
    }
    if (cs) await db.custom_exercises.bulkPut(cs);
  });
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
