"use client";

// Training goals and weekly sets-per-muscle targets.
// Targets default from the goal + experience, and the user can edit any number.
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./offline/db";
import { MUSCLE_GROUPS, type MuscleGroup } from "./muscles";

export type GoalType = "build_muscle" | "strength" | "general" | "fat_loss";
export type Experience = "beginner" | "intermediate" | "advanced";

export type Goals = {
  goalType: GoalType;
  experience: Experience;
  sessionsPerWeek: number;
  focusMuscles: MuscleGroup[];
  /** Per muscle, sets per week. Only muscles the user changed are stored. */
  targets: Partial<Record<MuscleGroup, number>>;
  note: string;
};

export const GOAL_LABELS: Record<GoalType, string> = {
  build_muscle: "Build muscle",
  strength: "Get stronger",
  general: "General fitness",
  fat_loss: "Lose fat",
};

export const EXPERIENCE_LABELS: Record<Experience, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

export const DEFAULT_GOALS: Goals = {
  goalType: "build_muscle",
  experience: "intermediate",
  sessionsPerWeek: 3,
  focusMuscles: [],
  targets: {},
  note: "",
};

/** Muscles that rarely need direct work; they get less by default. */
const SMALL: MuscleGroup[] = ["Forearms", "Neck", "Traps", "Lower back", "Calves", "Hips/Adductors/Abductors"];

/**
 * Sets per week for one muscle, before any manual edit.
 * Focus muscles get more; small muscles and fat-loss/general goals get less.
 */
export function defaultTarget(muscle: MuscleGroup, goals: Goals): number {
  const base =
    goals.experience === "beginner" ? 8 : goals.experience === "advanced" ? 14 : 11;
  const byGoal = goals.goalType === "strength" ? -2 : goals.goalType === "fat_loss" || goals.goalType === "general" ? -3 : 0;
  const size = SMALL.includes(muscle) ? -4 : 0;
  const focus = goals.focusMuscles.includes(muscle) ? 4 : 0;
  // Keep each session reasonable: fewer sessions means fewer sets per muscle.
  const sessions = goals.sessionsPerWeek <= 2 ? -3 : goals.sessionsPerWeek >= 5 ? 2 : 0;
  return Math.max(4, Math.min(24, base + byGoal + size + focus + sessions));
}

/** Target for every muscle, with the user's own numbers applied. */
export function allTargets(goals: Goals): Record<MuscleGroup, number> {
  const out = {} as Record<MuscleGroup, number>;
  for (const m of MUSCLE_GROUPS) out[m] = goals.targets[m] ?? defaultTarget(m, goals);
  return out;
}

const KEY = "goals";

export function useGoals(): Goals {
  const stored = useLiveQuery(async () => (await db.meta.get(KEY))?.value as Partial<Goals> | undefined, []);
  return { ...DEFAULT_GOALS, ...stored };
}

export async function saveGoals(patch: Partial<Goals>) {
  await db.transaction("rw", db.meta, async () => {
    const cur = ((await db.meta.get(KEY))?.value as Partial<Goals> | undefined) ?? {};
    await db.meta.put({ key: KEY, value: { ...DEFAULT_GOALS, ...cur, ...patch } });
  });
}

/** Set (or clear, with null) one muscle's weekly target. */
export async function setTarget(muscle: MuscleGroup, sets: number | null) {
  await db.transaction("rw", db.meta, async () => {
    const cur = { ...DEFAULT_GOALS, ...((await db.meta.get(KEY))?.value as Partial<Goals> | undefined) };
    const targets = { ...cur.targets };
    if (sets === null) delete targets[muscle];
    else targets[muscle] = Math.max(0, Math.min(40, Math.round(sets)));
    await db.meta.put({ key: KEY, value: { ...cur, targets } });
  });
}
