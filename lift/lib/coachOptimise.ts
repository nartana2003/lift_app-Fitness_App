// Optimise: compares the saved split and its routines with the user's goals and
// proposes specific, explained changes the user can accept or reject one by one.
// Rule-based and deterministic: no AI, no I/O, no React, so it works offline and
// the AI route can run it on the server and only re-word the result. Applying a
// change is in lib/coachApply.ts (that module writes to Dexie).
import type { Exercise } from "./exercises";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "./muscles";
// Type-only imports: lib/goals.ts and lib/splits.ts are client modules (Dexie).
import type { Priority } from "./goals";
import type { Split, SplitDay } from "./splits";
import { suggestForMuscle } from "./suggest";
import {
  BELOW_TARGET_RATIO,
  movementKey,
  REVIEW_DEFAULT_SETS,
  REVIEW_PICKS_PER_SESSION,
  reviewSetup,
  targetFor,
  type ReviewFinding,
  type ReviewGoals,
  type ReviewPool,
} from "./coachReview";
import { allowedFor, filterByLimitations, type Limitation } from "./limitations";
import { evidenceFor, knownEvidenceIds } from "./evidence/library";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OptimiseGoals = ReviewGoals & {
  limitations?: readonly Limitation[];
  /** Exercise ids the user never wants suggested. */
  dislikedIds?: readonly string[];
};

export type PlanExercise = { exercise_id: string; target_sets: number; target_reps: string };

/** A routine as the Coach sees it. Pass only kind "routine" rows, newest first. */
export type PlanRoutine = {
  id: string;
  name: string;
  split_day_id?: string | null;
  exercises: readonly PlanExercise[];
};

export type OptimiseInput = {
  goals: OptimiseGoals;
  split: Split;
  routines: readonly PlanRoutine[];
  catalogue: readonly Exercise[];
  /** Equipment the user has. Empty = full gym (no filter), as in lib/coachReview.ts. */
  equipment: readonly Equipment[];
};

export type MuscleStatus = "good" | "ok" | "low" | "none";

export type MuscleAnalysis = {
  muscle: MuscleGroup;
  priority: Priority | null;
  target: number;
  /** Working sets a week from the routines (or an estimate for a day with no routine). */
  weeklySets: number;
  /** Times a week a direct exercise for it comes round. */
  directPerWeek: number;
  onSplit: boolean;
  /** True when some of the sets are an estimate because a day has no routine. */
  estimated: boolean;
  status: MuscleStatus;
};

export type Analysis = {
  rows: MuscleAnalysis[];
  /** "Lift noticed" lines about goals the plan does not reflect. */
  notes: string[];
  findings: ReviewFinding[];
};

export type ChangeKind = "add_muscle" | "add_exercise" | "swap_exercise" | "more_sets";

export type Change = {
  /** Stable for the same input, so a screen can keep accept/reject state. */
  id: string;
  kind: ChangeKind;
  muscle: MuscleGroup;
  dayId: string;
  routineId: string | null;
  /** The exercise added, swapped in, or given more sets. Null for add_muscle. */
  exerciseId: string | null;
  /** swap_exercise only: the exercise taken out. */
  replaceExerciseId: string | null;
  /** add_exercise: its sets. more_sets: the new total. */
  sets: number | null;
  reps: string | null;
  why: string;
  /** Ids of Evidence Library entries that back the change. */
  evidenceIds: string[];
};

export type Proposals = {
  changes: Change[];
  /** Muscles where the limits and dislikes left no exercise to suggest. */
  emptied: MuscleGroup[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_CHANGES = 8;
/** A set is added to an exercise only up to this many. */
export const MAX_SETS_PER_EXERCISE = 5;
const NEW_EXERCISE_SETS = 3;
const NEW_EXERCISE_REPS = "8-12";
const CANDIDATES = 12;
/** A low-priority muscle with this many times its target is called out. */
const OVERDONE_RATIO = 1.5;
const MAX_NOTES = 6;
const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

type SetsByMuscle = Map<MuscleGroup, number>;

type Ctx = {
  input: OptimiseInput;
  byId: Map<string, Exercise>;
  days: (SplitDay & { id: string })[];
  /** Routine used for each day id (the first one, so the newest). */
  routineOf: Map<string, PlanRoutine>;
  /** Sets per muscle for each day id. */
  daySets: Map<string, SetsByMuscle>;
  /** Day ids whose sets are an estimate (no routine). */
  estimatedDays: Set<string>;
  /** Times a week each split day comes round. */
  factor: number;
  priorityOf: (m: MuscleGroup) => Priority | null;
};

function buildCtx(input: OptimiseInput): Ctx {
  const byId = new Map<string, Exercise>();
  for (const e of input.catalogue) if (!byId.has(e.id)) byId.set(e.id, e);
  const allDays = input.split?.days ?? [];
  const days = allDays.filter((d): d is SplitDay & { id: string } => typeof d.id === "string" && d.id.length > 0);
  const sessions = clamp(Math.floor(input.goals.sessionsPerWeek) || 1, 1, 7);
  const factor = allDays.length === 0 ? 0 : sessions / allDays.length;

  const routineOf = new Map<string, PlanRoutine>();
  for (const r of input.routines) if (r.split_day_id && !routineOf.has(r.split_day_id)) routineOf.set(r.split_day_id, r);

  const daySets = new Map<string, SetsByMuscle>();
  const estimatedDays = new Set<string>();
  for (const d of days) {
    const sets: SetsByMuscle = new Map();
    const routine = routineOf.get(d.id);
    if (routine) {
      for (const x of routine.exercises) {
        for (const m of byId.get(x.exercise_id)?.muscle_groups ?? []) sets.set(m, (sets.get(m) ?? 0) + x.target_sets);
      }
    } else {
      estimatedDays.add(d.id);
      for (const m of d.muscles) sets.set(m, REVIEW_PICKS_PER_SESSION * REVIEW_DEFAULT_SETS);
    }
    daySets.set(d.id, sets);
  }

  const { priorities, focusMuscles } = input.goals;
  const priorityOf = (m: MuscleGroup): Priority | null => priorities?.[m] ?? (focusMuscles.includes(m) ? "high" : null);
  return { input, byId, days, routineOf, daySets, estimatedDays, factor, priorityOf };
}

const dayTotal = (ctx: Ctx, dayId: string) => [...(ctx.daySets.get(dayId)?.values() ?? [])].reduce((a, n) => a + n, 0);

function statusOf(weekly: number, target: number): MuscleStatus {
  if (weekly <= 0) return "none";
  const ratio = weekly / target;
  return ratio < BELOW_TARGET_RATIO ? "low" : ratio < 1 ? "ok" : "good";
}

function timesWord(n: number): string {
  if (n === 1) return "once";
  if (n === 2) return "twice";
  return `${round1(n)} times`;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * How well the saved split and routines cover the goals. One row per muscle that
 * has a priority, is on a split day or gets sets. Weekly sets add up the sets in
 * the routine linked to each day, times how often the split comes round (sessions a
 * week over split days); a day with no routine counts as the review's default
 * picks x sets, and the row says it is an estimate.
 */
export function analyseSplit(input: OptimiseInput): Analysis {
  const ctx = buildCtx(input);
  const { goals } = input;

  const rows: MuscleAnalysis[] = [];
  for (const m of MUSCLE_GROUPS) {
    let weekly = 0;
    let direct = 0;
    let estimated = false;
    let onSplit = false;
    for (const d of ctx.days) {
      if (d.muscles.includes(m)) onSplit = true;
      const sets = ctx.daySets.get(d.id)?.get(m) ?? 0;
      if (sets > 0) {
        onSplit = true;
        weekly += sets * ctx.factor;
        direct += ctx.factor;
        if (ctx.estimatedDays.has(d.id)) estimated = true;
      }
    }
    const priority = ctx.priorityOf(m);
    if (!priority && !onSplit) continue;
    const target = targetFor(m, goals);
    rows.push({
      muscle: m,
      priority,
      target,
      weeklySets: round1(weekly),
      directPerWeek: round1(direct),
      onSplit,
      estimated,
      status: statusOf(weekly, target),
    });
  }

  const notes: string[] = [];
  const ranked = [...rows].sort((a, b) => PRIORITY_ORDER[a.priority ?? "low"] - PRIORITY_ORDER[b.priority ?? "low"]);
  for (const r of ranked) {
    if (notes.length >= MAX_NOTES) break;
    if ((r.priority === "high" || r.priority === "medium") && r.directPerWeek < 2) {
      const label = r.priority === "high" ? "a high priority" : "a medium priority";
      notes.push(
        !r.onSplit
          ? `${r.muscle} is ${label}, but no day of your split trains it.`
          : r.directPerWeek === 0
            ? `${r.muscle} is ${label}, but your routines have no exercise for it.`
            : `${r.muscle} is ${label}, but it is trained directly only ${timesWord(r.directPerWeek)} a week.`,
      );
    } else if (r.priority === "low" && r.weeklySets > r.target * OVERDONE_RATIO) {
      notes.push(`${r.muscle} is a low priority but gets about ${Math.round(r.weeklySets)} sets a week, more than you need.`);
    }
  }

  // The pool for the review is what the routines already use, by primary muscle.
  const pool: Partial<Record<MuscleGroup, string[]>> = {};
  for (const r of input.routines) {
    for (const x of r.exercises) {
      for (const m of ctx.byId.get(x.exercise_id)?.muscle_groups ?? []) {
        pool[m] = [...new Set([...(pool[m] ?? []), x.exercise_id])];
      }
    }
  }
  const findings = reviewSetup({ goals, split: input.split, pool: pool as ReviewPool, catalogue: input.catalogue, equipment: input.equipment }).findings;

  return { rows, notes, findings };
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

function strengthOrSize(ctx: Ctx): string {
  return ctx.input.goals.goalType === "strength" ? "volume-strength" : "volume-hypertrophy";
}

/** Evidence for a change: the general volume finding plus any about this exact exercise. */
function evidenceForExercise(ctx: Ctx, exerciseId: string | null, withVolume: boolean): string[] {
  const own = exerciseId ? evidenceFor({ exerciseId }).map((e) => e.id) : [];
  return knownEvidenceIds([...(withVolume ? [strengthOrSize(ctx)] : []), ...own]).slice(0, 3);
}

/**
 * Exercises that can be suggested for a muscle: catalogue exercises for it that fit
 * the user's equipment, are not already in any routine, are not disliked and do not
 * load a chosen limitation. Exercises with research behind them come first, then the
 * order suggestForMuscle gives. `emptied` is true when the limits and dislikes
 * removed every candidate there would otherwise have been.
 */
function candidatesFor(ctx: Ctx, muscle: MuscleGroup, taken: ReadonlySet<string>, avoidMoves: ReadonlySet<string>) {
  const { equipment, goals } = ctx.input;
  const allowedGear = equipment.length ? new Set<string>(equipment) : null;
  const disliked = new Set(goals.dislikedIds ?? []);
  const base = ctx.input.catalogue.filter((e) => (!allowedGear || allowedGear.has(e.equipment)) && !taken.has(e.id));
  const ranked = suggestForMuscle(base, muscle, CANDIDATES);
  const afterDislikes = ranked.filter((e) => !disliked.has(e.id));
  const { allowed, emptied } = filterByLimitations(afterDislikes, goals.limitations ?? []);
  const list = allowed
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        Number(avoidMoves.has(movementKey(a.e.name))) - Number(avoidMoves.has(movementKey(b.e.name))) ||
        Number(evidenceFor({ exerciseId: b.e.id }).length > 0) - Number(evidenceFor({ exerciseId: a.e.id }).length > 0) ||
        a.i - b.i,
    )
    .map((x) => x.e);
  return { list, emptied: emptied || (ranked.length > 0 && afterDislikes.length === 0) };
}

/**
 * Specific changes, safest first: swaps for exercises the user dislikes or whose
 * movement loads a chosen limitation, then growth for the goals (a muscle that no
 * day trains, a high priority trained once a week, a muscle under its weekly
 * target). At most MAX_CHANGES, each with a plain `why` and evidence ids from the
 * library. Nothing is changed here; see lib/coachApply.ts.
 */
export function proposeChanges(input: OptimiseInput): Proposals {
  const ctx = buildCtx(input);
  const { goals } = input;
  const analysis = analyseSplit(input);
  const changes: Change[] = [];
  const emptied: MuscleGroup[] = [];
  const full = () => changes.length >= MAX_CHANGES;
  const push = (c: Change) => {
    if (!full() && !changes.some((x) => x.id === c.id)) changes.push(c);
  };
  const markEmptied = (m: MuscleGroup) => {
    if (!emptied.includes(m)) emptied.push(m);
  };

  const inRoutines = new Set<string>();
  const movesByMuscle = new Map<MuscleGroup, Set<string>>();
  for (const r of ctx.routineOf.values()) {
    for (const x of r.exercises) {
      inRoutines.add(x.exercise_id);
      const e = ctx.byId.get(x.exercise_id);
      for (const m of e?.muscle_groups ?? []) movesByMuscle.set(m, (movesByMuscle.get(m) ?? new Set()).add(movementKey(e!.name)));
    }
  }
  const taken = new Set(inRoutines);

  // 1) Safety: swap exercises the user dislikes or that load a chosen limitation.
  const limits = goals.limitations ?? [];
  const disliked = new Set(goals.dislikedIds ?? []);
  for (const d of ctx.days) {
    const routine = ctx.routineOf.get(d.id);
    if (!routine) continue;
    for (const x of routine.exercises) {
      const old = ctx.byId.get(x.exercise_id);
      if (!old || (!disliked.has(old.id) && allowedFor(old, limits))) continue;
      const muscle = old.muscle_groups[0];
      if (!muscle) continue;
      const { list, emptied: none } = candidatesFor(ctx, muscle, taken, new Set());
      const pick = list.find((e) => e.mechanic === old.mechanic) ?? list[0];
      if (!pick) {
        if (none) markEmptied(muscle);
        continue;
      }
      taken.add(pick.id);
      const flagged = limits.filter((l) => !allowedFor(old, [l]));
      push({
        id: `swap_exercise:${routine.id}:${old.id}`,
        kind: "swap_exercise",
        muscle,
        dayId: d.id,
        routineId: routine.id,
        exerciseId: pick.id,
        replaceExerciseId: old.id,
        sets: null,
        reps: null,
        why: disliked.has(old.id)
          ? `You marked ${old.name} as never suggest. ${pick.name} trains ${muscle} too.`
          : `${old.name} can load your ${flagged.join(" and ").toLowerCase()}. ${pick.name} trains ${muscle} with a different movement.`,
        evidenceIds: evidenceForExercise(ctx, pick.id, false),
      });
    }
  }

  // 2) Growth, most important muscles first.
  const wanted = analysis.rows
    .filter((r) => r.priority !== "low")
    .filter((r) => {
      if (r.priority === "high" || r.priority === "medium") {
        return !r.onSplit || r.status === "low" || r.status === "none" || (r.priority === "high" && r.directPerWeek < 2 && ctx.days.length >= 2);
      }
      return r.onSplit && (r.status === "low" || r.status === "none");
    })
    .sort((a, b) => PRIORITY_ORDER[a.priority ?? "low"] - PRIORITY_ORDER[b.priority ?? "low"] || MUSCLE_GROUPS.indexOf(a.muscle) - MUSCLE_GROUPS.indexOf(b.muscle));

  const addExercise = (r: MuscleAnalysis, day: SplitDay & { id: string }, routine: PlanRoutine, reasonLead: string) => {
    const { list, emptied: none } = candidatesFor(ctx, r.muscle, taken, movesByMuscle.get(r.muscle) ?? new Set());
    const pick = list[0];
    if (!pick) {
      if (none) markEmptied(r.muscle);
      return false;
    }
    taken.add(pick.id);
    push({
      id: `add_exercise:${routine.id}:${pick.id}`,
      kind: "add_exercise",
      muscle: r.muscle,
      dayId: day.id,
      routineId: routine.id,
      exerciseId: pick.id,
      replaceExerciseId: null,
      sets: NEW_EXERCISE_SETS,
      reps: NEW_EXERCISE_REPS,
      why: `${pick.name} adds direct ${r.muscle} work to ${day.name}. ${reasonLead}`,
      evidenceIds: evidenceForExercise(ctx, pick.id, true),
    });
    return true;
  };

  const lead = (r: MuscleAnalysis) => {
    const pri = r.priority ? `${r.muscle} is a ${r.priority} priority and ` : `${r.muscle} `;
    return r.weeklySets === 0
      ? `${pri}gets no direct sets, against a target of ${r.target} a week.`
      : `${pri}gets about ${Math.round(r.weeklySets)} sets a week, below your target of ${r.target}.`;
  };

  for (const r of wanted) {
    if (full()) break;
    const trainsIt = (d: SplitDay) => (ctx.daySets.get(d.id!)?.get(r.muscle) ?? 0) > 0 && !ctx.estimatedDays.has(d.id!);
    const lightestFirst = (list: (SplitDay & { id: string })[]) => [...list].sort((a, b) => dayTotal(ctx, a.id) - dayTotal(ctx, b.id));

    // A muscle no day trains, or a high priority trained once a week: put it on another day.
    const needsDay = !r.onSplit || (r.priority === "high" && r.directPerWeek < 2 && ctx.days.length >= 2 && r.status !== "low" && r.status !== "none");
    if (needsDay) {
      const target = lightestFirst(ctx.days.filter((d) => !d.muscles.includes(r.muscle) && !trainsIt(d)))[0];
      if (target) {
        push({
          id: `add_muscle:${target.id}:${r.muscle}`,
          kind: "add_muscle",
          muscle: r.muscle,
          dayId: target.id,
          routineId: null,
          exerciseId: null,
          replaceExerciseId: null,
          sets: null,
          reps: null,
          why: !r.onSplit
            ? `${r.muscle} is a ${r.priority ?? "goal"} priority but no day of your split trains it. ${target.name} is your lightest day.`
            : `${r.muscle} is a high priority and is trained directly only ${timesWord(r.directPerWeek)} a week. Adding it to ${target.name}, your lightest day, trains it more often.`,
          evidenceIds: knownEvidenceIds([r.onSplit ? "frequency-twice-weekly" : strengthOrSize(ctx)]),
        });
        const routine = ctx.routineOf.get(target.id);
        if (routine) addExercise(r, target, routine, lead(r));
        continue;
      }
    }

    // On the split but under target: add an exercise, or a set when it already has two.
    const homes = lightestFirst(ctx.days.filter((d) => d.muscles.includes(r.muscle) && ctx.routineOf.has(d.id)));
    const home = homes[0];
    if (!home) continue;
    const routine = ctx.routineOf.get(home.id)!;
    const mine = routine.exercises.filter((x) => ctx.byId.get(x.exercise_id)?.muscle_groups.includes(r.muscle));
    if (mine.length < 2) {
      if (addExercise(r, home, routine, lead(r))) continue;
    }
    const lowest = [...mine].sort((a, b) => a.target_sets - b.target_sets)[0];
    if (lowest && lowest.target_sets < MAX_SETS_PER_EXERCISE) {
      const name = ctx.byId.get(lowest.exercise_id)?.name ?? "this exercise";
      push({
        id: `more_sets:${routine.id}:${lowest.exercise_id}`,
        kind: "more_sets",
        muscle: r.muscle,
        dayId: home.id,
        routineId: routine.id,
        exerciseId: lowest.exercise_id,
        replaceExerciseId: null,
        sets: lowest.target_sets + 1,
        reps: null,
        why: `Add a set to ${name}. ${lead(r)}`,
        evidenceIds: evidenceForExercise(ctx, lowest.exercise_id, true),
      });
    }
  }

  return { changes, emptied };
}
