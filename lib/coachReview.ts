// Setup review: checks a split and an exercise pool against the user's goals and
// suggests catalogue exercises to add. Rule-based and deterministic: no AI, no I/O,
// no React, so it works offline and can run on the server (COACH-02 falls back to it).
import type { Exercise } from "./exercises";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "./muscles";
import { suggestForMuscle } from "./suggest";
// Type-only imports: lib/goals.ts and lib/splits.ts are client modules (Dexie),
// so nothing runtime is pulled in from them.
import type { Goals } from "./goals";
import type { Split } from "./splits";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The parts of the saved goals this review reads. `Goals` from lib/goals.ts fits as is. */
export type ReviewGoals = Pick<Goals, "goalType" | "experience" | "sessionsPerWeek" | "focusMuscles"> & {
  /** The user's own weekly targets (only muscles they changed). */
  targets?: Goals["targets"];
};

/**
 * The user's pool per muscle: either catalogue ids (the AI route shape) or
 * exercises (the `MusclePool` from lib/pool.ts). Ids not in the catalogue are ignored.
 */
export type ReviewPool = Partial<Record<MuscleGroup, readonly (string | Exercise)[]>>;

export type FindingCode =
  | "no_split"
  | "too_many_days"
  | "too_few_days"
  | "no_exercises"
  | "one_exercise"
  | "focus_few_days"
  | "focus_few_exercises"
  | "not_in_split"
  | "below_target";

export type Severity = "info" | "warn";

export type ReviewFinding = {
  code: FindingCode;
  /** The muscle the finding is about, or null for whole-split findings. */
  muscle: MuscleGroup | null;
  message: string;
  severity: Severity;
};

export type ReviewSuggestion = {
  muscle: MuscleGroup;
  exercise_id: string;
  exercise: Exercise;
  /** One plain line on why it is suggested. */
  reason: string;
};

/** Rough weekly set load for a muscle on the split. */
export type MuscleLoad = {
  muscle: MuscleGroup;
  /** Split days that train it. */
  splitDays: number;
  /** Exercises for it in the pool. */
  poolSize: number;
  /** Estimated working sets per week (one decimal). */
  weeklySets: number;
  /** The user's target, or the rule default. */
  target: number;
};

export type SetupReview = {
  findings: ReviewFinding[];
  suggestions: ReviewSuggestion[];
  /** One row per muscle on the split, in MUSCLE_GROUPS order. */
  load: MuscleLoad[];
};

export type ReviewInput = {
  goals: ReviewGoals;
  split: Split;
  pool: ReviewPool;
  catalogue: readonly Exercise[];
  /** Equipment the user has. Empty = full gym (no filter), as in lib/pool.ts. */
  equipment: readonly Equipment[];
  /** Exercises picked per muscle per session (default 2). */
  picksPerSession?: number;
  /** Working sets per exercise (default 3, the same as DEFAULT_SETS in lib/routines.ts). */
  setsPerExercise?: number;
  /** Suggestions per muscle (default and max 3). */
  suggestionsPerMuscle?: number;
};

// ---------------------------------------------------------------------------
// Constants and rule baseline
// ---------------------------------------------------------------------------

/** Same as DEFAULT_SETS in lib/routines.ts (client module; the tests check they match). */
export const REVIEW_DEFAULT_SETS = 3;
export const REVIEW_PICKS_PER_SESSION = 2;
export const MAX_SUGGESTIONS_PER_MUSCLE = 3;
/** Load below this share of the target counts as "well below". */
export const BELOW_TARGET_RATIO = 0.75;
/** How many of the best-ranked candidates the variety passes look at. */
const VARIETY_WINDOW = 10;

/** Same list as lib/goals.ts: muscles that rarely need direct work. */
const SMALL: readonly MuscleGroup[] = ["Forearms", "Neck", "Traps", "Lower back", "Calves", "Hips/Adductors/Abductors"];

/**
 * Same formula as defaultTarget() in lib/goals.ts. That module is client-only, so
 * the formula is copied here and the tests check both agree for every input.
 */
export function reviewDefaultTarget(muscle: MuscleGroup, goals: ReviewGoals): number {
  const base = goals.experience === "beginner" ? 8 : goals.experience === "advanced" ? 14 : 11;
  const byGoal = goals.goalType === "strength" ? -2 : goals.goalType === "fat_loss" || goals.goalType === "general" ? -3 : 0;
  const size = SMALL.includes(muscle) ? -4 : 0;
  const focus = goals.focusMuscles.includes(muscle) ? 4 : 0;
  const sessions = goals.sessionsPerWeek <= 2 ? -3 : goals.sessionsPerWeek >= 5 ? 2 : 0;
  return Math.max(4, Math.min(24, base + byGoal + size + focus + sessions));
}

/** The user's own target when set, else the rule default (same as allTargets()). */
function targetFor(muscle: MuscleGroup, goals: ReviewGoals): number {
  const own = goals.targets?.[muscle];
  return typeof own === "number" && Number.isFinite(own) ? own : reviewDefaultTarget(muscle, goals);
}

const MUSCLE_SET = new Set<string>(MUSCLE_GROUPS);
const isMuscle = (m: unknown): m is MuscleGroup => typeof m === "string" && MUSCLE_SET.has(m);
const byMuscleOrder = (a: MuscleGroup, b: MuscleGroup) => MUSCLE_GROUPS.indexOf(a) - MUSCLE_GROUPS.indexOf(b);

const intOr = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : fallback;

function joinNames(list: readonly string[]): string {
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Movement variety
// ---------------------------------------------------------------------------

/** Movement words, so suggestions are not three near-identical exercises. */
const MOVEMENTS = new Set([
  "curl", "press", "row", "squat", "lunge", "deadlift", "raise", "fly", "flye", "extension",
  "pulldown", "pushdown", "pull-up", "chin-up", "pullup", "chinup", "push-up", "pushup", "dip",
  "shrug", "crunch", "sit-up", "situp", "plank", "bridge", "thrust", "kickback", "twist",
  "rollout", "pullover", "step-up", "swing", "clean", "snatch", "carry", "walk", "bend", "rotation",
]);

/** Variation words that make two exercises of the same movement feel different. */
const VARIANTS = new Set([
  "hammer", "preacher", "incline", "decline", "concentration", "reverse", "overhead", "close-grip",
  "wide-grip", "spider", "drag", "zottman", "front", "lateral", "rear", "sumo", "romanian", "split",
  "bulgarian", "hip", "glute", "calf", "leg", "single-leg", "one-arm", "upright", "seated", "lying", "standing",
]);

function normWord(t: string, set: Set<string>): string | null {
  if (set.has(t)) return t;
  if (t.endsWith("es") && set.has(t.slice(0, -2))) return t.slice(0, -2);
  if (t.endsWith("s") && set.has(t.slice(0, -1))) return t.slice(0, -1);
  return null;
}

/** e.g. "Incline Hammer Curls" -> "hammer curl"; "Barbell Hip Thrust" -> "hip thrust". */
export function movementKey(name: string): string {
  const tokens = name.toLowerCase().replace(/[^a-z-]+/g, " ").split(" ").filter(Boolean);
  let movement: string | null = null;
  for (const t of tokens) movement = normWord(t, MOVEMENTS) ?? movement;
  movement ??= tokens[tokens.length - 1] ?? "";
  let variant = "";
  for (const t of tokens) {
    const v = normWord(t, VARIANTS);
    if (v && v !== movement) {
      variant = v;
      break;
    }
  }
  return variant ? `${variant} ${movement}` : movement;
}

/** The movement word alone ("hammer curl" -> "curl"). */
const movementOf = (key: string) => key.split(" ").pop() ?? key;

const EQUIPMENT_WORD: Record<Equipment, string> = {
  "Machine/Cable": "machine or cable",
  Dumbbell: "dumbbell",
  Barbell: "barbell",
  Bodyweight: "bodyweight",
  Bands: "band",
  Kettlebell: "kettlebell",
  Other: "",
};

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * Reviews a split and pool against the goals.
 *
 * Findings (split-level first, then per muscle in MUSCLE_GROUPS order):
 * - no_split: the split has no days.
 * - too_many_days: more split days than sessions per week.
 * - too_few_days: goal muscles (focus muscles and muscles with an own target) that
 *   no day trains while the split has fewer days than sessions per week.
 * - no_exercises / one_exercise: a split muscle with 0 / 1 exercise in the pool.
 * - focus_few_exercises: a focus muscle with fewer than 2 pool exercises (replaces
 *   no_exercises / one_exercise for that muscle).
 * - focus_few_days: a focus muscle on exactly one split day.
 * - not_in_split: a goal muscle that no split day trains.
 * - below_target: a split muscle whose rough weekly sets are well below its target.
 *
 * Weekly sets = min(picksPerSession, pool size) x setsPerExercise x times the muscle
 * comes round per week. The split cycles over the sessions, so that is
 * sessionsPerWeek x (days with the muscle / split days); when the split has one day
 * per session this is simply the number of days it appears.
 *
 * Suggestions: for each muscle with a finding, up to 3 catalogue exercises for it
 * that are not in the pool (any muscle), pass the equipment filter and are not
 * already suggested for another muscle. Candidates come in suggestForMuscle() order
 * (compounds and common gym kit first); among the top 10 a pick prefers a movement,
 * then a variation or equipment, not yet in the pool or the picks. The final list
 * per muscle puts compounds first.
 */
export function reviewSetup(input: ReviewInput): SetupReview {
  const { goals } = input;
  const per = intOr(input.picksPerSession, REVIEW_PICKS_PER_SESSION, 1, 10);
  const sets = intOr(input.setsPerExercise, REVIEW_DEFAULT_SETS, 1, 10);
  const maxSuggest = intOr(input.suggestionsPerMuscle, MAX_SUGGESTIONS_PER_MUSCLE, 0, MAX_SUGGESTIONS_PER_MUSCLE);

  const days = (input.split?.days ?? []).map((d) => ({
    name: typeof d?.name === "string" ? d.name : "",
    muscles: [...new Set((d?.muscles ?? []).filter(isMuscle))],
  }));
  const dayCount = days.length;
  const sessions = intOr(goals.sessionsPerWeek, Math.max(1, dayCount), 1, 7);
  const focus = [...new Set((goals.focusMuscles ?? []).filter(isMuscle))].sort(byMuscleOrder);
  const ownTargets = Object.entries(goals.targets ?? {})
    .filter(([m, v]) => isMuscle(m) && typeof v === "number" && v > 0)
    .map(([m]) => m as MuscleGroup);
  const goalMuscles = [...new Set([...focus, ...ownTargets])].sort(byMuscleOrder);

  // Catalogue by id (first wins) and the pool resolved to exercises.
  const byId = new Map<string, Exercise>();
  for (const e of input.catalogue) if (e && typeof e.id === "string" && !byId.has(e.id)) byId.set(e.id, e);
  const pool = new Map<MuscleGroup, Exercise[]>();
  const poolIds = new Set<string>();
  for (const m of MUSCLE_GROUPS) {
    const seen = new Set<string>();
    const list: Exercise[] = [];
    for (const item of input.pool?.[m] ?? []) {
      const e = typeof item === "string" ? byId.get(item) : item && typeof item.id === "string" ? item : undefined;
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      poolIds.add(e.id);
      list.push(e);
    }
    pool.set(m, list);
  }
  const poolOf = (m: MuscleGroup) => pool.get(m) ?? [];

  const daysFor = (m: MuscleGroup) => days.filter((d) => d.muscles.includes(m)).length;
  const splitMuscles = MUSCLE_GROUPS.filter((m) => daysFor(m) > 0);

  const findings: ReviewFinding[] = [];
  const add = (code: FindingCode, muscle: MuscleGroup | null, severity: Severity, message: string) =>
    findings.push({ code, muscle, severity, message });

  // Split-level findings.
  const uncovered = goalMuscles.filter((m) => daysFor(m) === 0);
  if (dayCount === 0) {
    add("no_split", null, "warn", "You have no split yet. Add one so the app knows which muscles to train on each day.");
  } else {
    if (dayCount > sessions)
      add(
        "too_many_days",
        null,
        "warn",
        `Your split has ${dayCount} days but you train ${plural(sessions, "time")} a week, so each day comes round less than once a week.`,
      );
    if (uncovered.length > 0 && dayCount < sessions)
      add(
        "too_few_days",
        null,
        "warn",
        `Your split has ${plural(dayCount, "day")} but you train ${plural(sessions, "time")} a week, and ${joinNames(uncovered)} ${uncovered.length === 1 ? "is" : "are"} on no day. Add a day or put ${uncovered.length === 1 ? "it" : "them"} on an existing day.`,
      );
  }

  // Per-muscle findings and load.
  const load: MuscleLoad[] = [];
  const timesPerWeek = (m: MuscleGroup) => (dayCount === 0 ? 0 : (sessions * daysFor(m)) / dayCount);
  for (const m of MUSCLE_GROUPS) {
    const isFocus = focus.includes(m);
    const inSplit = daysFor(m) > 0;
    const list = poolOf(m);
    const n = list.length;

    if (isFocus && n < 2)
      add(
        "focus_few_exercises",
        m,
        "warn",
        n === 0
          ? `${m} is a focus muscle but has no exercises in your pool. Add at least 2.`
          : `${m} is a focus muscle but has only one exercise in your pool (${list[0].name}). Add at least one more.`,
      );
    else if (inSplit && n === 0)
      add("no_exercises", m, "warn", `${m} is on your split but has no exercises in your pool. Star a few so the app can pick them.`);
    else if (inSplit && n === 1)
      add("one_exercise", m, "info", `${m} has only one exercise in your pool (${list[0].name}). Add another so you can rotate.`);

    if (dayCount > 0 && isFocus && daysFor(m) === 1)
      add("focus_few_days", m, "warn", `${m} is a focus muscle but is on only 1 split day. Train it on at least 2 days.`);

    if (dayCount > 0 && !inSplit && goalMuscles.includes(m))
      add(
        "not_in_split",
        m,
        "warn",
        isFocus ? `${m} is a focus muscle but no split day trains it.` : `${m} has a weekly target but no split day trains it.`,
      );

    if (inSplit) {
      const target = targetFor(m, goals);
      const weekly = Math.round(Math.min(per, n) * sets * timesPerWeek(m) * 10) / 10;
      load.push({ muscle: m, splitDays: daysFor(m), poolSize: n, weeklySets: weekly, target });
      // An empty pool is already flagged; only judge load when there is something to pick.
      if (n > 0 && weekly < target * BELOW_TARGET_RATIO)
        add(
          "below_target",
          m,
          isFocus ? "warn" : "info",
          `${m} gets about ${Math.round(weekly)} sets a week, below your target of ${target}.`,
        );
    }
  }

  // Suggestions for every muscle with a finding.
  const allowed = input.equipment.length ? new Set<string>(input.equipment) : null;
  const usable = [...byId.values()].filter((e) => !allowed || allowed.has(e.equipment));
  const suggested = new Set<string>();
  const suggestions: ReviewSuggestion[] = [];
  const flagged: MuscleGroup[] = [];
  for (const f of findings) if (f.muscle && !flagged.includes(f.muscle)) flagged.push(f.muscle);

  for (const m of flagged) {
    if (maxSuggest === 0) break;
    const ranked = suggestForMuscle(usable, m, usable.length).filter((e) => !poolIds.has(e.id) && !suggested.has(e.id));
    const usedKeys = new Set(poolOf(m).map((e) => movementKey(e.name)));
    const usedMoves = new Set([...usedKeys].map(movementOf));
    const usedEquip = new Set<string>(poolOf(m).map((e) => e.equipment));
    const picks: Exercise[] = [];
    // Variety passes look only at the best-ranked candidates, so variety never
    // drags in obscure exercises; the last pass fills from the whole ranked list.
    const top = ranked.slice(0, VARIETY_WINDOW);
    const passes: [readonly Exercise[], (e: Exercise) => boolean][] = [
      [top, (e) => !usedMoves.has(movementOf(movementKey(e.name)))],
      [top, (e) => !usedKeys.has(movementKey(e.name)) && !usedEquip.has(e.equipment)],
      [top, (e) => !usedKeys.has(movementKey(e.name))],
      [top, (e) => !usedEquip.has(e.equipment)],
      [ranked, () => true],
    ];
    for (const [list, ok] of passes) {
      for (const e of list) {
        if (picks.length >= maxSuggest) break;
        if (picks.includes(e) || !ok(e)) continue;
        picks.push(e);
        const key = movementKey(e.name);
        usedKeys.add(key);
        usedMoves.add(movementOf(key));
        usedEquip.add(e.equipment);
      }
    }
    const ordered = picks
      .map((e, i) => ({ e, i }))
      .sort((a, b) => Number(b.e.mechanic === "compound") - Number(a.e.mechanic === "compound") || a.i - b.i)
      .map((x) => x.e);
    const poolKeys = new Set(poolOf(m).map((e) => movementOf(movementKey(e.name))));
    for (const e of ordered) {
      suggested.add(e.id);
      suggestions.push({ muscle: m, exercise_id: e.id, exercise: e, reason: reasonFor(e, m, poolOf(m).length, poolKeys) });
    }
  }

  return { findings, suggestions, load };
}

function reasonFor(e: Exercise, muscle: MuscleGroup, poolSize: number, poolMoves: Set<string>): string {
  const kind = e.mechanic === "compound" ? "Compound" : "Isolation";
  const kit = EQUIPMENT_WORD[e.equipment] ?? "";
  const what = `${kind}${kit ? ` ${kit}` : ""} exercise for ${muscle}`;
  if (poolSize === 0) return `${what}, so it has something in your pool.`;
  if (!poolMoves.has(movementOf(movementKey(e.name)))) return `${what}, a different movement from your pool.`;
  return `${what}, a different variation from what you have.`;
}
