/**
 * Server-only pure logic shared by the goal-aware AI routes: the goal and
 * experience lists, the weekly-target bounds, the rule-based target and the
 * strict goals/split/recent-weeks input validator.
 *
 * The rule baseline mirrors defaultTarget() in lib/goals.ts. That module is a
 * client module (it imports Dexie), so it is only imported for types here; the
 * test suite checks that ruleTarget() and defaultTarget() agree everywhere.
 */
import { validateInput as validateRoutinesInput } from "./generate-routines";
import { MUSCLE_GROUPS, type MuscleGroup } from "../muscles";
// Type-only imports: these are client modules, nothing runtime is pulled in.
import type { Experience, GoalType, Goals } from "../goals";
import type { Split } from "../splits";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Bounds for any weekly target (same as defaultTarget). */
export const MIN_TARGET = 4;
export const MAX_TARGET = 24;
export const MAX_WEEKS = 4;
export const MAX_WEEK_SETS = 200;
/** setTarget() in lib/goals.ts stores user numbers in 0..40. */
export const MAX_USER_TARGET = 40;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const GOAL_TYPES = ["build_muscle", "strength", "general", "fat_loss"] as const satisfies readonly GoalType[];
export const EXPERIENCES = ["beginner", "intermediate", "advanced"] as const satisfies readonly Experience[];

// ---------------------------------------------------------------------------
// Rule baseline (mirrors lib/goals.ts defaultTarget)
// ---------------------------------------------------------------------------

/** Muscles that rarely need direct work; same list as lib/goals.ts. */
export const SMALL_MUSCLES: readonly MuscleGroup[] = ["Forearms", "Neck", "Traps", "Lower back", "Calves", "Hips/Adductors/Abductors"];

export type GoalSettings = Pick<Goals, "goalType" | "experience" | "sessionsPerWeek" | "focusMuscles">;

export const clampTarget = (n: number) => Math.max(MIN_TARGET, Math.min(MAX_TARGET, Math.round(n)));

/** Same formula as defaultTarget() in lib/goals.ts. */
export function ruleTarget(muscle: MuscleGroup, goals: GoalSettings): number {
  const base = goals.experience === "beginner" ? 8 : goals.experience === "advanced" ? 14 : 11;
  const byGoal = goals.goalType === "strength" ? -2 : goals.goalType === "fat_loss" || goals.goalType === "general" ? -3 : 0;
  const size = SMALL_MUSCLES.includes(muscle) ? -4 : 0;
  const focus = goals.focusMuscles.includes(muscle) ? 4 : 0;
  const sessions = goals.sessionsPerWeek <= 2 ? -3 : goals.sessionsPerWeek >= 5 ? 2 : 0;
  return clampTarget(base + byGoal + size + focus + sessions);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type WeekSets = {
  /** YYYY-MM-DD, the first day of the week. */
  week_start: string;
  /** Hard sets done per muscle that week. Missing muscles mean 0. */
  sets: Partial<Record<MuscleGroup, number>>;
};

export type GoalTargetsInput = {
  goals: GoalSettings & {
    /** The user's own numbers, if any (context only; never copied into the result). */
    targets: Partial<Record<MuscleGroup, number>>;
  };
  /** Null when the user has no split. */
  split: Split | null;
  /** Up to 4 weeks, sorted oldest first. */
  recent_weeks: WeekSets[];
};

export type ValidateResult = { ok: true; input: GoalTargetsInput } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));
const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isMuscle = (v: unknown): v is MuscleGroup => typeof v === "string" && (MUSCLE_GROUPS as readonly string[]).includes(v);

/** A { muscle: int } map with only known muscles and ints in lo..hi, or null. */
function muscleMap(v: unknown, lo: number, hi: number): Partial<Record<MuscleGroup, number>> | null {
  if (!isObj(v)) return null;
  const out: Partial<Record<MuscleGroup, number>> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!isMuscle(k) || !isInt(n, lo, hi)) return null;
    out[k] = n;
  }
  return out;
}

/**
 * Strict shape check of the request body (already JSON-parsed). Unknown keys,
 * wrong types, unknown muscles and out-of-range numbers are rejected. The split
 * goes through the same validator as /api/ai/generate-routines.
 */
export function validateInput(raw: unknown): ValidateResult {
  const bad = (error: string): ValidateResult => ({ ok: false, error });
  if (!isObj(raw) || !onlyKeys(raw, ["goals", "split", "recent_weeks"])) return bad("body");

  const g = raw.goals;
  if (!isObj(g) || !onlyKeys(g, ["goalType", "experience", "sessionsPerWeek", "focusMuscles", "targets"])) return bad("goals");
  if (typeof g.goalType !== "string" || !(GOAL_TYPES as readonly string[]).includes(g.goalType)) return bad("goals.goalType");
  if (typeof g.experience !== "string" || !(EXPERIENCES as readonly string[]).includes(g.experience)) return bad("goals.experience");
  const sessionsPerWeek = g.sessionsPerWeek ?? 3;
  if (!isInt(sessionsPerWeek, 1, 7)) return bad("goals.sessionsPerWeek");
  const fm = g.focusMuscles ?? [];
  if (!Array.isArray(fm) || fm.length > MUSCLE_GROUPS.length) return bad("goals.focusMuscles");
  const focusMuscles: MuscleGroup[] = [];
  for (const m of fm) {
    if (!isMuscle(m)) return bad("goals.focusMuscles");
    if (!focusMuscles.includes(m)) focusMuscles.push(m);
  }
  const targets = muscleMap(g.targets ?? {}, 0, MAX_USER_TARGET);
  if (!targets) return bad("goals.targets");

  let split: Split | null = null;
  if (raw.split !== undefined && raw.split !== null) {
    const r = validateRoutinesInput({ split: raw.split });
    if (!r.ok) return bad(r.error);
    split = r.input.split;
  }

  const rw = raw.recent_weeks ?? [];
  if (!Array.isArray(rw) || rw.length > MAX_WEEKS) return bad("recent_weeks");
  const recent_weeks: WeekSets[] = [];
  for (const w of rw) {
    if (!isObj(w) || !onlyKeys(w, ["week_start", "sets"])) return bad("recent_weeks");
    if (typeof w.week_start !== "string" || !DATE_RE.test(w.week_start)) return bad("recent_weeks.week_start");
    if (recent_weeks.some((x) => x.week_start === w.week_start)) return bad("recent_weeks.week_start");
    const sets = muscleMap(w.sets, 0, MAX_WEEK_SETS);
    if (!sets) return bad("recent_weeks.sets");
    recent_weeks.push({ week_start: w.week_start, sets });
  }
  recent_weeks.sort((a, b) => a.week_start.localeCompare(b.week_start));

  return {
    ok: true,
    input: {
      goals: { goalType: g.goalType as GoalType, experience: g.experience as Experience, sessionsPerWeek, focusMuscles, targets },
      split,
      recent_weeks,
    },
  };
}

