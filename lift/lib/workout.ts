"use client";

// Live-workout state machine over the persisted `active` row.
import { db, uuid, type ActiveExercise, type ActiveSet, type ActiveWorkout, type SetRow } from "./offline/db";
import { enqueue } from "./offline/sync";
import { dayKey, markDone } from "./planner";
import { exerciseBests, lastSession } from "./history";
import { applySet, isVolumePr, setPrs, type PrType } from "./prs";

const KEY = "active";

export const getActive = () => db.active.get(KEY);

async function mutate(fn: (w: ActiveWorkout) => void) {
  await db.transaction("rw", db.active, async () => {
    const w = await db.active.get(KEY);
    if (!w) return;
    fn(w);
    await db.active.put(w);
  });
}

const blankSet = (prev?: ActiveSet): ActiveSet => ({
  id: uuid(),
  reps: prev?.reps ?? "",
  weight: prev?.weight ?? "",
  is_warmup: false,
  rir: null,
  done: false,
});

/** Exercise row pre-filled from last time (same number of sets, same weights/reps). */
async function exerciseFromHistory(exerciseId: string, targetSets?: number, targetReps?: string): Promise<ActiveExercise> {
  const last = await lastSession(exerciseId);
  const work = last?.sets.filter((s) => !s.is_warmup) ?? [];
  const n = targetSets ?? (work.length || 3);
  const sets: ActiveSet[] = Array.from({ length: n }, (_, i) => {
    const p = work[i] ?? work[work.length - 1];
    return { ...blankSet(), reps: p?.reps ?? "", weight: p?.weight ?? "" };
  });
  return { id: uuid(), exercise_id: exerciseId, sets, ...(targetReps ? { target_reps: targetReps } : {}) };
}

export async function startWorkout(opts: {
  name?: string;
  routineId?: string;
  exercises?: { exercise_id: string; target_sets?: number; target_reps?: string }[];
} = {}) {
  const exercises = await Promise.all(
    (opts.exercises ?? []).map((e) => exerciseFromHistory(e.exercise_id, e.target_sets, e.target_reps)),
  );
  const w: ActiveWorkout = {
    key: KEY,
    id: uuid(),
    started_at: new Date().toISOString(),
    routine_id: opts.routineId ?? null,
    name: opts.name ?? null,
    exercises,
  };
  await db.active.put(w);
  return w;
}

export async function addExercises(exerciseIds: string[]) {
  const rows = await Promise.all(exerciseIds.map((id) => exerciseFromHistory(id)));
  await mutate((w) => w.exercises.push(...rows));
}

export const removeExercise = (exId: string) =>
  mutate((w) => void (w.exercises = w.exercises.filter((e) => e.id !== exId)));

export const moveExercise = (exId: string, dir: -1 | 1) =>
  mutate((w) => {
    const i = w.exercises.findIndex((e) => e.id === exId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= w.exercises.length) return;
    [w.exercises[i], w.exercises[j]] = [w.exercises[j], w.exercises[i]];
  });

export const addSet = (exId: string) =>
  mutate((w) => {
    const ex = w.exercises.find((e) => e.id === exId);
    if (ex) ex.sets.push(blankSet(ex.sets[ex.sets.length - 1]));
  });

export const removeSet = (exId: string, setId: string) =>
  mutate((w) => {
    const ex = w.exercises.find((e) => e.id === exId);
    if (ex) ex.sets = ex.sets.filter((s) => s.id !== setId);
  });

export const updateSet = (exId: string, setId: string, patch: Partial<ActiveSet>) =>
  mutate((w) => {
    const s = w.exercises.find((e) => e.id === exId)?.sets.find((x) => x.id === setId);
    if (s) Object.assign(s, patch);
  });

/** Tick a set done (or undo). Returns any PRs it set. */
export async function toggleSetDone(exId: string, setId: string): Promise<PrType[]> {
  const w = await getActive();
  const ex = w?.exercises.find((e) => e.id === exId);
  const set = ex?.sets.find((s) => s.id === setId);
  if (!w || !ex || !set) return [];

  if (set.done) {
    await updateSet(exId, setId, { done: false, pr: undefined });
    return [];
  }

  const reps = Number(set.reps) || 0;
  const weight = Number(set.weight) || 0;
  let prs: PrType[] = [];
  if (!set.is_warmup && reps > 0) {
    let bests = await exerciseBests(ex.exercise_id, w.id);
    const hadHistory = bests.weight > 0 || Object.keys(bests.repsAtWeight).length > 0;
    for (const s of ex.sets) {
      if (s.done && s.id !== setId) bests = applySet(bests, { reps: Number(s.reps) || 0, weight: Number(s.weight) || 0, is_warmup: s.is_warmup });
    }
    // No celebration for the very first time you log an exercise.
    prs = hadHistory ? setPrs({ reps, weight }, bests) : [];
    const doneSets = ex.sets.filter((s) => s.done || s.id === setId).map((s) => ({ reps: Number(s.reps) || 0, weight: Number(s.weight) || 0, is_warmup: s.is_warmup }));
    if (hadHistory && isVolumePr(doneSets, bests) && !ex.sets.some((s) => s.pr?.includes("volume"))) prs.push("volume");
  }
  await updateSet(exId, setId, { done: true, reps, weight, pr: prs.length ? prs : undefined });
  return prs;
}

export async function discardWorkout() {
  await db.active.delete(KEY);
}

/** Persist the finished workout locally + queue for sync. Only ticked sets are saved. */
export async function finishWorkout(notes?: string): Promise<string | null> {
  const w = await getActive();
  if (!w) return null;
  const endedAt = new Date().toISOString();

  const workout = { id: w.id, started_at: w.started_at, ended_at: endedAt, notes: notes ?? w.name ?? null, routine_id: w.routine_id };
  const wes: { id: string; workout_id: string; exercise_id: string; position: number }[] = [];
  const sets: SetRow[] = [];
  const prs: Record<string, unknown>[] = [];

  w.exercises.forEach((ex) => {
    const done = ex.sets.filter((s) => s.done && Number(s.reps) > 0);
    if (!done.length) return;
    wes.push({ id: ex.id, workout_id: w.id, exercise_id: ex.exercise_id, position: wes.length });
    done.forEach((s, i) => {
      const row: SetRow = {
        id: s.id,
        workout_exercise_id: ex.id,
        set_no: i + 1,
        reps: Number(s.reps),
        weight: Number(s.weight) || 0,
        is_warmup: s.is_warmup,
        rir: s.rir,
        completed_at: endedAt,
      };
      sets.push(row);
      for (const type of s.pr ?? []) {
        prs.push({
          id: uuid(),
          exercise_id: ex.exercise_id,
          type,
          value: type === "weight" ? row.weight : type === "reps" ? row.reps : type === "e1rm" ? Math.round(row.weight * (1 + row.reps / 30) * 10) / 10 : 0,
          reps: row.reps,
          weight: row.weight,
          set_id: row.id,
          achieved_at: endedAt,
        });
      }
    });
  });

  // The workout and its outbox entries commit together, so a pull running at
  // the same time can never delete a finished workout that is not queued yet.
  await db.transaction("rw", db.workouts, db.workout_exercises, db.sets, db.active, db.outbox, async () => {
    if (wes.length) {
      await db.workouts.put(workout);
      await db.workout_exercises.bulkPut(wes);
      await db.sets.bulkPut(sets);
      await enqueue([
        { table: "workouts", op: "upsert", row: workout },
        ...wes.map((row) => ({ table: "workout_exercises" as const, op: "upsert" as const, row })),
        ...sets.map((row) => ({ table: "sets" as const, op: "upsert" as const, row })),
        ...prs.map((row) => ({ table: "personal_records" as const, op: "upsert" as const, row })),
      ]);
    }
    await db.active.delete(KEY);
  });
  if (!wes.length) return null;
  await markDone(dayKey(new Date(w.started_at)), w.id);
  return w.id;
}

// ---------- rest time per exercise (local; default 90s) ----------
export async function getRestSec(exerciseId: string): Promise<number> {
  const per = await db.meta.get(`rest:${exerciseId}`);
  if (typeof per?.value === "number") return per.value;
  const def = await db.meta.get("default_rest_sec");
  return typeof def?.value === "number" ? def.value : 90;
}

export async function setRestSec(exerciseId: string | null, sec: number) {
  await db.meta.put({ key: exerciseId ? `rest:${exerciseId}` : "default_rest_sec", value: sec });
}

/** Replace an exercise in the live workout, keeping any sets already ticked off. */
export async function swapExercise(exId: string, newExerciseId: string) {
  const w = await getActive();
  const ex = w?.exercises.find((e) => e.id === exId);
  if (!ex) return;
  const keep = ex.sets.filter((s) => s.done);
  const fresh = await exerciseFromHistory(newExerciseId, Math.max(1, ex.sets.length - keep.length), ex.target_reps);
  await mutate((cur) => {
    const i = cur.exercises.findIndex((e) => e.id === exId);
    if (i < 0) return;
    if (keep.length > 0) {
      // Keep the finished sets under the old exercise, and add the new one after it.
      cur.exercises[i] = { ...ex, sets: keep };
      cur.exercises.splice(i + 1, 0, fresh);
    } else {
      cur.exercises[i] = fresh;
    }
  });
}
