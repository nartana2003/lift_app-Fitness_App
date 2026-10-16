"use client";

// Read helpers over the local store.
import { db, type SetRow, type WorkoutRow } from "./offline/db";
import { bestsFromHistory, emptyBests, type Bests } from "./prs";

export type ExerciseSession = { workout: WorkoutRow; sets: SetRow[] };

/** Sessions of one exercise, newest first. */
export async function exerciseSessions(exerciseId: string, limit = 50): Promise<ExerciseSession[]> {
  const wes = await db.workout_exercises.where("exercise_id").equals(exerciseId).toArray();
  const workouts = await db.workouts.bulkGet(wes.map((w) => w.workout_id));
  const out: ExerciseSession[] = [];
  for (let i = 0; i < wes.length; i++) {
    const w = workouts[i];
    if (!w || !w.ended_at) continue;
    const sets = (await db.sets.where("workout_exercise_id").equals(wes[i].id).toArray()).sort(
      (a, b) => a.set_no - b.set_no,
    );
    if (sets.length) out.push({ workout: w, sets });
  }
  // Merge if the same exercise appears twice in one workout.
  const merged = new Map<string, ExerciseSession>();
  for (const s of out) {
    const m = merged.get(s.workout.id);
    if (m) m.sets.push(...s.sets);
    else merged.set(s.workout.id, { ...s, sets: [...s.sets] });
  }
  return [...merged.values()]
    .sort((a, b) => b.workout.started_at.localeCompare(a.workout.started_at))
    .slice(0, limit);
}

export async function lastSession(exerciseId: string): Promise<ExerciseSession | undefined> {
  return (await exerciseSessions(exerciseId, 1))[0];
}

export async function exerciseBests(exerciseId: string, excludeWorkoutId?: string): Promise<Bests> {
  const sessions = (await exerciseSessions(exerciseId, 1000)).filter((s) => s.workout.id !== excludeWorkoutId);
  return sessions.length ? bestsFromHistory(sessions.map((s) => s.sets)) : emptyBests();
}

export type WorkoutDetail = WorkoutRow & {
  exercises: { id: string; exercise_id: string; position: number; sets: SetRow[] }[];
  volume: number;
  setCount: number;
};

export async function workoutDetail(w: WorkoutRow): Promise<WorkoutDetail> {
  const wes = (await db.workout_exercises.where("workout_id").equals(w.id).toArray()).sort(
    (a, b) => a.position - b.position,
  );
  let volume = 0;
  let setCount = 0;
  const exercises = [];
  for (const we of wes) {
    const sets = (await db.sets.where("workout_exercise_id").equals(we.id).toArray()).sort(
      (a, b) => a.set_no - b.set_no,
    );
    for (const s of sets) {
      if (s.is_warmup) continue;
      volume += s.reps * s.weight;
      setCount++;
    }
    exercises.push({ ...we, sets });
  }
  return { ...w, exercises, volume, setCount };
}

/** Finished workouts in [from, to), newest first, with details. */
export async function workoutsBetween(from: Date, to: Date): Promise<WorkoutDetail[]> {
  const ws = await db.workouts
    .where("started_at")
    .between(from.toISOString(), to.toISOString(), true, false)
    .filter((w) => !!w.ended_at)
    .reverse()
    .sortBy("started_at");
  return Promise.all(ws.map(workoutDetail));
}

/** Every exercise that has been logged in a finished workout, most recently done first. */
export async function loggedExercises(): Promise<{ exercise_id: string; last: string; count: number }[]> {
  const [wes, workouts] = await Promise.all([db.workout_exercises.toArray(), db.workouts.toArray()]);
  const byId = new Map(workouts.map((w) => [w.id, w]));
  const acc = new Map<string, { last: string; count: number }>();
  for (const we of wes) {
    const w = byId.get(we.workout_id);
    if (!w?.ended_at) continue;
    const cur = acc.get(we.exercise_id);
    if (!cur) acc.set(we.exercise_id, { last: w.started_at, count: 1 });
    else {
      cur.count++;
      if (w.started_at > cur.last) cur.last = w.started_at;
    }
  }
  return [...acc.entries()]
    .map(([exercise_id, v]) => ({ exercise_id, ...v }))
    .sort((a, b) => b.last.localeCompare(a.last));
}

/** All finished workouts (the local store only holds a year or so, so this stays small). */
export const allWorkouts = () => workoutsBetween(new Date(2000, 0, 1), new Date(Date.now() + 864e5));
