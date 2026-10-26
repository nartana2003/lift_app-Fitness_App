"use client";

// Fetching from Lyfta, remembering exercise matches, and writing imported workouts.
import { ensureCustomExercise } from "../customExercises";
import type { Exercise } from "../exercises";
import { db } from "../offline/db";
import { writeAndQueue } from "../offline/sync";
import type { Unit } from "../units";
import { convertWorkouts, summariseExercises, type ExerciseSummary, type LyftaWorkout } from "./convert";
import { matchExercise, type Candidate, type Confidence } from "./match";

const KEY_META = "lyfta_key";
const MAP_META = "lyfta_map";

export const getSavedKey = async () => ((await db.meta.get(KEY_META))?.value as string | undefined) ?? "";
export const saveKey = (key: string) => db.meta.put({ key: KEY_META, value: key });
export const forgetKey = () => db.meta.delete(KEY_META);

const getSavedMap = async () => ((await db.meta.get(MAP_META))?.value as Record<string, string> | undefined) ?? {};

export async function fetchLyfta(opts: { sandbox: boolean; key: string }): Promise<LyftaWorkout[]> {
  const res = await fetch(`/api/lyfta/workouts${opts.sandbox ? "?sandbox=1" : ""}`, {
    headers: opts.sandbox ? {} : { "x-lyfta-key": opts.key },
  });
  const body = (await res.json().catch(() => ({}))) as { workouts?: LyftaWorkout[]; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Lyfta import failed (${res.status})`);
  return body.workouts ?? [];
}

export type Choice = { kind: "catalogue"; id: string } | { kind: "custom" };
export type PlanRow = ExerciseSummary & { confidence: Confidence | "saved"; candidates: Candidate[]; choice: Choice };

/** One row per distinct Lyfta exercise, pre-filled with our best guess (or what you chose last time). */
export async function buildPlan(workouts: LyftaWorkout[], catalogue: Exercise[]): Promise<PlanRow[]> {
  const saved = await getSavedMap();
  const known = new Set(catalogue.map((e) => e.id));
  return summariseExercises(workouts).map((s) => {
    const m = matchExercise(s.name, catalogue.filter((e) => !e.id.startsWith("custom-")));
    const prev = saved[s.lyfta_id];
    if (prev && (known.has(prev) || prev.startsWith("custom-")))
      return { ...s, confidence: "saved" as const, candidates: m.candidates, choice: { kind: "catalogue" as const, id: prev } };
    return {
      ...s,
      confidence: m.confidence,
      candidates: m.candidates,
      choice: m.best ? { kind: "catalogue" as const, id: m.best.id } : { kind: "custom" as const },
    };
  });
}

export type ImportResult = { imported: number; alreadyHad: number; sets: number; customCreated: number; skippedSets: number };

export async function runImport(workouts: LyftaWorkout[], plan: PlanRow[], unit: Unit): Promise<ImportResult> {
  const mapping: Record<string, string> = {};
  let customCreated = 0;
  for (const row of plan) {
    if (row.choice.kind === "catalogue") {
      mapping[row.lyfta_id] = row.choice.id;
    } else {
      const guess = row.candidates[0]?.exercise;
      const c = await ensureCustomExercise(row.name, { muscle_groups: guess?.muscle_groups, equipment: guess?.equipment });
      mapping[row.lyfta_id] = c.id;
      customCreated++;
    }
  }
  await db.meta.put({ key: MAP_META, value: { ...(await getSavedMap()), ...mapping } });

  const conv = convertWorkouts(workouts, mapping, unit);
  const have = new Set((await db.workouts.bulkGet(conv.workouts.map((w) => w.id))).filter(Boolean).map((w) => w!.id));
  const newWorkouts = conv.workouts.filter((w) => !have.has(w.id));
  const newIds = new Set(newWorkouts.map((w) => w.id));
  const wes = conv.workout_exercises.filter((e) => newIds.has(e.workout_id));
  const weIds = new Set(wes.map((e) => e.id));
  const sets = conv.sets.filter((s) => weIds.has(s.workout_exercise_id));

  // Rows and their outbox items commit together, so a pull running meanwhile
  // can never delete freshly imported workouts that are not queued yet.
  await writeAndQueue([db.workouts, db.workout_exercises, db.sets], async () => {
    await db.workouts.bulkPut(newWorkouts);
    await db.workout_exercises.bulkPut(wes);
    await db.sets.bulkPut(sets);
    return [
      ...newWorkouts.map((row) => ({ table: "workouts" as const, op: "upsert" as const, row })),
      ...wes.map((row) => ({ table: "workout_exercises" as const, op: "upsert" as const, row })),
      ...sets.map((row) => ({ table: "sets" as const, op: "upsert" as const, row })),
    ];
  });

  return { imported: newWorkouts.length, alreadyHad: have.size, sets: sets.length, customCreated, skippedSets: conv.skippedSets };
}
