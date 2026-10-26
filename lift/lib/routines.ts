"use client";

// Saved routines: a named list of exercises with a target number of sets and a rep range.
// Stored on-device first and queued for sync, like workouts.
import { db, uuid, type ActiveWorkout, type RoutineExerciseRow, type RoutineRow } from "./offline/db";
import { enqueue } from "./offline/sync";

export type RoutineExerciseInput = { exercise_id: string; target_sets?: number; target_reps?: string };
export type Routine = RoutineRow & { exercises: RoutineExerciseRow[] };

export const DEFAULT_SETS = 3;
export const DEFAULT_REPS = "8-12";

/** "8-12" from the reps actually done, "10" if they were all the same. */
export function repRangeFrom(reps: number[]): string {
  const r = reps.filter((n) => n > 0);
  if (r.length === 0) return DEFAULT_REPS;
  const lo = Math.min(...r);
  const hi = Math.max(...r);
  return lo === hi ? String(lo) : `${lo}-${hi}`;
}

/** The exercises of an in-progress workout as routine exercises (working sets only, in order). */
export function routineExercisesFromActive(w: Pick<ActiveWorkout, "exercises">): RoutineExerciseInput[] {
  return w.exercises
    .map((e) => {
      const work = e.sets.filter((s) => !s.is_warmup);
      const reps = work.map((s) => Number(s.reps) || 0);
      return {
        exercise_id: e.exercise_id,
        target_sets: Math.max(1, work.length),
        target_reps: reps.some((n) => n > 0) ? repRangeFrom(reps) : (e.target_reps ?? DEFAULT_REPS),
      };
    })
    .filter((e, i, all) => all.findIndex((x) => x.exercise_id === e.exercise_id) === i);
}

const toRows = (routineId: string, list: RoutineExerciseInput[]): RoutineExerciseRow[] =>
  list.map((e, position) => ({
    id: uuid(),
    routine_id: routineId,
    exercise_id: e.exercise_id,
    position,
    target_sets: Math.max(1, Math.round(e.target_sets ?? DEFAULT_SETS)),
    target_reps: e.target_reps?.trim() || DEFAULT_REPS,
  }));

export async function createRoutine(input: {
  name: string;
  exercises: RoutineExerciseInput[];
  source?: RoutineRow["source"];
  kind?: RoutineRow["kind"];
  notes?: string;
  /** The split day this routine belongs to. Left out: no link (the field is not written). */
  split_day_id?: string | null;
}): Promise<string> {
  const row: RoutineRow = {
    id: uuid(),
    name: input.name.trim() || "My routine",
    day_label: null,
    source: input.source ?? "manual",
    kind: input.kind ?? "routine",
    source_url: null,
    platform: null,
    thumbnail_url: null,
    creator: null,
    notes: input.notes?.trim() || null,
    created_at: new Date().toISOString(),
  };
  if (input.split_day_id !== undefined) row.split_day_id = input.split_day_id || null;
  const exercises = toRows(row.id, input.exercises);
  await db.transaction("rw", db.routines, db.routine_exercises, async () => {
    await db.routines.put(row);
    await db.routine_exercises.bulkPut(exercises);
  });
  await enqueue([
    { table: "routines", op: "upsert", row },
    ...exercises.map((r) => ({ table: "routine_exercises" as const, op: "upsert" as const, row: r })),
  ]);
  return row.id;
}

/** Change the name/notes and/or replace the exercise list. */
export async function updateRoutine(
  id: string,
  patch: { name?: string; notes?: string | null; exercises?: RoutineExerciseInput[]; split_day_id?: string | null },
) {
  const cur = await db.routines.get(id);
  if (!cur) return;
  const next: RoutineRow = {
    ...cur,
    name: patch.name !== undefined ? patch.name.trim() || cur.name : cur.name,
    notes: patch.notes !== undefined ? patch.notes?.trim() || null : cur.notes,
  };
  if (patch.split_day_id !== undefined) next.split_day_id = patch.split_day_id || null;
  const items: Parameters<typeof enqueue>[0] = [{ table: "routines", op: "upsert", row: next }];
  let fresh: RoutineExerciseRow[] | undefined;
  let old: RoutineExerciseRow[] = [];
  if (patch.exercises) {
    old = await db.routine_exercises.where("routine_id").equals(id).toArray();
    fresh = toRows(id, patch.exercises);
    for (const o of old) items.push({ table: "routine_exercises", op: "delete", row: { id: o.id } });
    for (const r of fresh) items.push({ table: "routine_exercises", op: "upsert", row: r });
  }
  await db.transaction("rw", db.routines, db.routine_exercises, async () => {
    await db.routines.put(next);
    if (fresh) {
      await db.routine_exercises.bulkDelete(old.map((o) => o.id));
      await db.routine_exercises.bulkPut(fresh);
    }
  });
  await enqueue(items);
}

/** Link a routine to a split day, or unlink it with null. Never touches its exercises. */
export const linkRoutineToDay = (routineId: string, dayId: string | null) =>
  updateRoutine(routineId, { split_day_id: dayId });

/**
 * Unlink every routine whose split day is not in `dayIds` (the day was deleted or
 * the split replaced). The routines are kept and become unassigned. Returns how many.
 */
export async function unlinkRoutinesOutside(dayIds: ReadonlySet<string>): Promise<number> {
  const stale = (await db.routines.toArray()).filter((r) => !!r.split_day_id && !dayIds.has(r.split_day_id));
  for (const r of stale) await updateRoutine(r.id, { split_day_id: null });
  return stale.length;
}

export async function deleteRoutine(id: string) {
  const old = await db.routine_exercises.where("routine_id").equals(id).toArray();
  await db.transaction("rw", db.routines, db.routine_exercises, async () => {
    await db.routine_exercises.bulkDelete(old.map((o) => o.id));
    await db.routines.delete(id);
  });
  // The server deletes the routine's exercises along with it (cascade).
  await enqueue([{ table: "routines", op: "delete", row: { id } }]);
}

export async function getRoutine(id: string): Promise<Routine | undefined> {
  const r = await db.routines.get(id);
  if (!r) return undefined;
  const exercises = (await db.routine_exercises.where("routine_id").equals(id).toArray()).sort((a, b) => a.position - b.position);
  return { ...r, exercises };
}

/** All routines, newest first, each with its exercises in order. */
export async function listRoutines(): Promise<Routine[]> {
  const [rs, es] = await Promise.all([db.routines.toArray(), db.routine_exercises.toArray()]);
  const by = new Map<string, RoutineExerciseRow[]>();
  for (const e of es) by.set(e.routine_id, [...(by.get(e.routine_id) ?? []), e]);
  return rs
    .map((r) => ({ ...r, exercises: (by.get(r.id) ?? []).sort((a, b) => a.position - b.position) }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
