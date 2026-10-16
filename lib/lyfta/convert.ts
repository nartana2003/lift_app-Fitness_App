// Turns Lyfta workouts into Lift rows. Pure: no storage or network, so it's easy to test.
import type { SetRow, WorkoutExerciseRow, WorkoutRow } from "../offline/db";
import { fromDisplay, type Unit } from "../units";

export type LyftaSet = {
  id?: string;
  weight?: string | number;
  reps?: string | number;
  rir?: string | number;
  duration?: string | number;
  set_type_id?: string | number;
  /** Unreliable: real Lyfta data marks performed sets as false, so we go by reps instead. */
  is_completed?: boolean;
};

export type LyftaExercise = {
  exercise_id: number | string;
  excercise_name?: string; // sic — that's the live field name
  exercise_name?: string;
  exercise_type?: string;
  exercise_rest_time?: number | string;
  sets?: LyftaSet[];
};

export type LyftaWorkout = {
  id: number | string;
  title?: string;
  workout_perform_date: string;
  /** "HH:MM:SS" (or seconds) when Lyfta provides it. */
  workout_duration?: string | number;
  exercises?: LyftaExercise[];
};

export const exerciseName = (e: LyftaExercise) => (e.excercise_name ?? e.exercise_name ?? `Exercise ${e.exercise_id}`).trim();

/** Deterministic UUID from a string, so re-importing the same Lyfta workout never duplicates it. */
export function stableUuid(input: string): string {
  // cyrb128: four 32-bit hashes → 128 bits. Works on plain http (no crypto.subtle needed).
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < input.length; i++) {
    const k = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const hex = [h1, h2, h3, h4].map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${"89ab"[parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Lyfta sends "2026-10-08 08:28:46" (UTC, no zone) or a proper ISO string. */
export function parseLyftaDate(s: string): Date {
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(s.trim());
  return new Date(hasZone ? s : s.trim().replace(" ", "T") + "Z");
}

/** "01:14:08" → 4448, "74:08" → 4448, 600 → 600; unknown → 0. */
export function parseDuration(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : 0;
  const parts = String(v ?? "").split(":").map((p) => parseFloat(p));
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

/** A performed set has reps (or a duration). */
const performed = (s: LyftaSet) => num(s.reps) > 0 || num(s.duration) > 0;

export type ExerciseSummary = { lyfta_id: string; name: string; sets: number; type?: string };

/** Distinct exercises across the workouts, with how many completed sets each has. */
export function summariseExercises(workouts: LyftaWorkout[]): ExerciseSummary[] {
  const m = new Map<string, ExerciseSummary>();
  for (const w of workouts)
    for (const e of w.exercises ?? []) {
      const id = String(e.exercise_id);
      const done = (e.sets ?? []).filter(performed).length;
      const cur = m.get(id);
      if (cur) cur.sets += done;
      else m.set(id, { lyfta_id: id, name: exerciseName(e), sets: done, type: e.exercise_type });
    }
  return [...m.values()].sort((a, b) => b.sets - a.sets);
}

export type Converted = {
  workouts: WorkoutRow[];
  workout_exercises: WorkoutExerciseRow[];
  sets: SetRow[];
  skippedSets: number;
};

/** Lyfta gives no workout end time, so estimate: ~40s of work + the exercise's rest per set. */
export function estimateDurationSec(w: LyftaWorkout): number {
  let sec = 0;
  for (const e of w.exercises ?? []) {
    const rest = num(e.exercise_rest_time) || 90;
    for (const s of e.sets ?? []) if (performed(s)) sec += 40 + rest;
  }
  return Math.max(600, sec);
}

/**
 * @param mapping Lyfta exercise_id → our exercise id (every exercise must be mapped; unmapped ones are skipped)
 * @param unit    the unit Lyfta's weights are in
 */
export function convertWorkouts(workouts: LyftaWorkout[], mapping: Record<string, string>, unit: Unit): Converted {
  const out: Converted = { workouts: [], workout_exercises: [], sets: [], skippedSets: 0 };

  for (const w of workouts) {
    const wid = stableUuid(`lyfta:${w.id}`);
    const started = parseLyftaDate(w.workout_perform_date);
    if (Number.isNaN(started.getTime())) continue;

    let position = 0;
    let kept = 0;
    (w.exercises ?? []).forEach((e, ei) => {
      const ours = mapping[String(e.exercise_id)];
      if (!ours) {
        out.skippedSets += (e.sets ?? []).length;
        return;
      }
      const weId = stableUuid(`lyfta:${w.id}:${ei}`);
      let setNo = 0;
      (e.sets ?? []).forEach((s, si) => {
        const duration = num(s.duration);
        const reps = Math.round(num(s.reps)) || (duration > 0 ? Math.round(duration) : 0); // timed sets: seconds as "reps"
        if (reps <= 0) {
          out.skippedSets++;
          return;
        }
        const rirRaw = s.rir === undefined || s.rir === "" ? null : Math.round(num(s.rir));
        setNo++;
        out.sets.push({
          id: stableUuid(`lyfta:${w.id}:${ei}:${s.id ?? si}`),
          workout_exercise_id: weId,
          set_no: setNo,
          reps,
          weight: Math.round(fromDisplay(num(s.weight), unit) * 100) / 100,
          is_warmup: false,
          rir: rirRaw === null ? null : Math.max(0, Math.min(3, rirRaw)),
          completed_at: started.toISOString(),
        });
        kept++;
      });
      if (setNo > 0) out.workout_exercises.push({ id: weId, workout_id: wid, exercise_id: ours, position: position++ });
    });

    if (kept === 0) continue;
    out.workouts.push({
      id: wid,
      started_at: started.toISOString(),
      ended_at: new Date(started.getTime() + (parseDuration(w.workout_duration) || estimateDurationSec(w)) * 1000).toISOString(),
      notes: w.title?.trim() || null,
      routine_id: null,
    });
  }
  return out;
}
