"use client";

// Training goals and weekly sets-per-muscle targets.
// Targets default from the goal + experience, and the user can edit any number.
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./offline/db";
import { MUSCLE_GROUPS, type MuscleGroup } from "./muscles";
import type { Limitation } from "./limitations";
import type { Split } from "./splits";

export type GoalType = "build_muscle" | "strength" | "general" | "fat_loss";
export type Experience = "beginner" | "intermediate" | "advanced";
export type Priority = "high" | "medium" | "low";

export const PRIORITY_LABELS: Record<Priority, string> = { high: "High", medium: "Medium", low: "Low" };
/** Most typed goals the user can rank. */
export const MAX_RANKED_GOALS = 3;

export type Goals = {
  goalType: GoalType;
  experience: Experience;
  sessionsPerWeek: number;
  focusMuscles: MuscleGroup[];
  /** Per muscle, sets per week. Only muscles the user changed are stored. */
  targets: Partial<Record<MuscleGroup, number>>;
  /** The first typed goal. Kept equal to rankedGoals[0] for older readers. */
  note: string;
  /**
   * Per muscle priority. focusMuscles is always the "high" ones, so older readers
   * keep working. A muscle with no entry has no priority.
   */
  priorities: Partial<Record<MuscleGroup, Priority>>;
  /** Typed goals, most important first (max MAX_RANKED_GOALS). */
  rankedGoals: string[];
  /** Movement limits; the Coach never suggests exercises that load these. */
  limitations: Limitation[];
  /** Exercise ids the user never wants suggested. */
  dislikedIds: string[];
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
  priorities: {},
  rankedGoals: [],
  limitations: [],
  dislikedIds: [],
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
  const priority = goals.priorities?.[muscle] ?? (goals.focusMuscles.includes(muscle) ? "high" : undefined);
  const focus = priority === "high" ? 4 : priority === "medium" ? 2 : priority === "low" ? -2 : 0;
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

/**
 * Fills the Coach fields of goals saved before they existed: focus muscles become
 * "high" priority and the typed goal becomes the first ranked goal.
 */
export function normalizeGoals(raw: Partial<Goals> | undefined): Goals {
  const g: Goals = { ...DEFAULT_GOALS, ...raw };
  if (!g.priorities || Object.keys(g.priorities).length === 0) {
    g.priorities = Object.fromEntries(g.focusMuscles.map((m) => [m, "high" as const]));
  }
  if (!Array.isArray(g.rankedGoals) || g.rankedGoals.length === 0) g.rankedGoals = g.note.trim() ? [g.note.trim()] : [];
  if (!Array.isArray(g.limitations)) g.limitations = [];
  if (!Array.isArray(g.dislikedIds)) g.dislikedIds = [];
  return g;
}

/** Merges a patch into goals and keeps focusMuscles/priorities and note/rankedGoals equal. */
export function mergeGoals(cur: Goals, patch: Partial<Goals>): Goals {
  const next: Goals = { ...cur, ...patch };
  if (patch.priorities) {
    next.focusMuscles = MUSCLE_GROUPS.filter((m) => next.priorities[m] === "high");
  } else if (patch.focusMuscles) {
    const priorities = { ...cur.priorities };
    for (const m of MUSCLE_GROUPS) {
      if (next.focusMuscles.includes(m)) priorities[m] = "high";
      else if (priorities[m] === "high") delete priorities[m];
    }
    next.priorities = priorities;
  }
  if (patch.rankedGoals) {
    next.rankedGoals = patch.rankedGoals.map((t) => t.trim()).filter(Boolean).slice(0, MAX_RANKED_GOALS);
    next.note = next.rankedGoals[0] ?? "";
  } else if (patch.note !== undefined) {
    const first = patch.note.trim();
    next.rankedGoals = first ? [first, ...cur.rankedGoals.slice(1)] : cur.rankedGoals.slice(1);
  }
  return next;
}

/**
 * A short text of what the Coach plans for: changes when the user changes what
 * they want (typed goals, priorities, goal type, experience, days, limits).
 */
export function goalsFingerprint(goals: Partial<Goals>): string {
  const g = normalizeGoals(goals);
  return JSON.stringify([
    g.goalType,
    g.experience,
    g.sessionsPerWeek,
    g.rankedGoals,
    MUSCLE_GROUPS.filter((m) => g.priorities[m]).map((m) => `${m}:${g.priorities[m]}`),
    [...g.limitations].sort(),
  ]);
}

/** True when the split was built for goals that have since changed. A split with no builtFor never counts. */
export function goalsChanged(goals: Partial<Goals>, split: Pick<Split, "days" | "builtFor">): boolean {
  return !!split.builtFor && split.days.length > 0 && split.builtFor !== goalsFingerprint(goals);
}

const KEY = "goals";

export function useGoals(): Goals {
  const stored = useLiveQuery(async () => (await db.meta.get(KEY))?.value as Partial<Goals> | undefined, []);
  return normalizeGoals(stored);
}

export async function saveGoals(patch: Partial<Goals>) {
  await db.transaction("rw", db.meta, async () => {
    const cur = normalizeGoals((await db.meta.get(KEY))?.value as Partial<Goals> | undefined);
    await db.meta.put({ key: KEY, value: mergeGoals(cur, patch) });
  });
}

/** Set (or clear, with null) one muscle's weekly target. */
export async function setTarget(muscle: MuscleGroup, sets: number | null) {
  await db.transaction("rw", db.meta, async () => {
    const cur = normalizeGoals((await db.meta.get(KEY))?.value as Partial<Goals> | undefined);
    const targets = { ...cur.targets };
    if (sets === null) delete targets[muscle];
    else targets[muscle] = Math.max(0, Math.min(40, Math.round(sets)));
    await db.meta.put({ key: KEY, value: { ...cur, targets } });
  });
}
