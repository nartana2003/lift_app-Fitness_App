// Rule-based weekly catch-up plan: which exercises to add on which training day.
// Pure logic (no I/O). It uses only days the user trains, capped by their sessions
// per week, and prefers exercises already in their routines or history.
import type { PlannedDayRow } from "./offline/db";
import type { Exercise } from "./exercises";
import type { Equipment, MuscleGroup } from "./muscles";
import { suggestForMuscle } from "./suggest";
import { addDays, startOfWeek } from "./stats";

/** At most this many additions on one day. */
export const MAX_PER_DAY = 3;
/** Most sets one addition carries. */
export const MAX_SETS = 6;
/** Sets per addition before a muscle's remaining sets are split across days. */
const SETS_PER_PIECE = 3;

export type CatchUpAddition = {
  exercise_id: string;
  muscle: MuscleGroup;
  date: string;
  sets: number;
  reason: string;
  /** The exercise is already in that day's routine, so these are extra sets on it. */
  in_routine: boolean;
};

export type CatchUpInput = {
  /** Muscles under target, most important first. */
  behind: { muscle: MuscleGroup; remaining: number }[];
  /** Today and the rest of the week as YYYY-MM-DD, in order. */
  days: string[];
  /** This week's planned_days rows. */
  planned: PlannedDayRow[];
  /** Sessions per week in the user's goals, and sessions already done this week. */
  sessionsPerWeek: number;
  sessionsDone: number;
  /** routine id -> its exercises. */
  routines: Map<string, { name: string; exercises: { exercise_id: string; target_sets: number }[] }>;
  catalogue: Exercise[];
  /** Exercise id -> times logged, from workout history. */
  history: Map<string, number>;
  /** Starred exercises plus those in routines (see preferredIds). */
  favorites: string[];
  dislikedIds?: string[];
  /** Equipment the user has; empty or missing means no restriction. */
  equipment?: Equipment[];
};

export type CatchUpPlan = {
  /** The days the plan uses, in order. */
  trainingDays: string[];
  additions: CatchUpAddition[];
  /** Sets that did not fit (no usable exercise or every day full). */
  unmet: { muscle: MuscleGroup; sets: number }[];
  /** Sets per muscle that the routines already planned on the training days cover, so they are not added again. */
  covered: { muscle: MuscleGroup; sets: number }[];
  /** True when the user has already reached their sessions this week and nothing is planned. */
  noSessionsLeft: boolean;
};

/** Names of the routines the catch-up plan creates, so they can be told apart from the user's own. */
export const CATCH_UP_NAME = "Catch up";
export const CATCH_UP_SUFFIX = " + catch up";
export const isCatchUpRoutine = (name: string) => name === CATCH_UP_NAME || name.endsWith(CATCH_UP_SUFFIX);

/** Exercise ids by how many workouts they appear in. */
export function historyCounts(workouts: { exercises: { exercise_id: string }[] }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of workouts) for (const id of new Set(w.exercises.map((e) => e.exercise_id))) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

/** Number of days this week (from weekStart) with at least one workout. */
export function sessionsThisWeek(workouts: { started_at: string }[], weekStart: 0 | 1, now = new Date()): number {
  const from = startOfWeek(now, weekStart);
  const to = addDays(from, 7);
  const days = new Set<string>();
  for (const w of workouts) {
    const d = new Date(w.started_at);
    if (d >= from && d < to) days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  return days.size;
}

const dayNumber = (key: string) => Math.round(Date.parse(`${key}T00:00:00Z`) / 86_400_000);

/**
 * The days to plan on: every planned day left this week (the user chose them),
 * then free days, spread as far from the others as possible, until the sessions
 * left are reached. Done, skipped and moved days are never used.
 */
export function pickTrainingDays(days: string[], planned: PlannedDayRow[], sessionsLeft: number): string[] {
  const row = new Map(planned.map((p) => [p.date, p]));
  const chosen = days.filter((d) => row.get(d)?.status === "planned");
  const free = days.filter((d) => !row.has(d));
  while (chosen.length < sessionsLeft && free.length > 0) {
    let best = 0;
    let bestGap = -1;
    free.forEach((d, i) => {
      const gap = chosen.length ? Math.min(...chosen.map((c) => Math.abs(dayNumber(c) - dayNumber(d)))) : 99;
      if (gap > bestGap) {
        best = i;
        bestGap = gap;
      }
    });
    chosen.push(...free.splice(best, 1));
  }
  return chosen.sort();
}

/** Splits n sets into near-equal pieces of at most SETS_PER_PIECE: 7 -> [3, 2, 2]. */
export function splitSets(n: number): number[] {
  const total = Math.floor(n);
  if (!Number.isFinite(total) || total < 1) return [];
  const k = Math.ceil(total / SETS_PER_PIECE);
  const base = Math.floor(total / k);
  const extra = total % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

export function planCatchUp(input: CatchUpInput): CatchUpPlan {
  const sessionsLeft = Math.max(0, Math.round(input.sessionsPerWeek) - input.sessionsDone);
  const trainingDays = pickTrainingDays(input.days, input.planned, sessionsLeft);
  if (trainingDays.length === 0) return { trainingDays, additions: [], unmet: [], covered: [], noSessionsLeft: true };

  const byId = new Map(input.catalogue.map((e) => [e.id, e]));
  const disliked = new Set(input.dislikedIds ?? []);
  const allowed = input.equipment?.length ? new Set<Equipment>([...input.equipment, "Bodyweight"]) : null;
  const usable = (e: Exercise | undefined): e is Exercise => !!e && !disliked.has(e.id) && (!allowed || allowed.has(e.equipment));
  const trains = (e: Exercise | undefined, m: MuscleGroup) => !!e && e.muscle_groups.includes(m);

  const dayRoutine = new Map(trainingDays.map((d) => [d, input.routines.get(input.planned.find((p) => p.date === d)?.routine_id ?? "")]));
  const onDay = new Map(trainingDays.map((d) => [d, new Set(dayRoutine.get(d)?.exercises.map((e) => e.exercise_id) ?? [])]));
  const added = new Map<string, CatchUpAddition[]>(trainingDays.map((d) => [d, []]));
  // The user's own routines only: earlier catch-up copies must not feed the next plan.
  const routineIds = [...new Set([...input.routines.values()].filter((r) => !isCatchUpRoutine(r.name)).flatMap((r) => r.exercises.map((e) => e.exercise_id)))];

  /** The user's own exercises for a muscle: routines, then history, then favourites, then the catalogue ranking. */
  const candidates = (m: MuscleGroup): string[] => {
    const mine = routineIds.filter((id) => trains(byId.get(id), m) && usable(byId.get(id)));
    const logged = [...input.history.entries()]
      .filter(([id]) => trains(byId.get(id), m) && usable(byId.get(id)))
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    const fav = input.favorites.filter((id) => trains(byId.get(id), m) && usable(byId.get(id)));
    const ranked = suggestForMuscle(input.catalogue.filter(usable), m, 6, input.favorites).map((e) => e.id);
    return [...new Set([...mine, ...logged, ...fav, ...ranked])];
  };

  // Sets already planned on the training days count toward the targets even though they are not done yet.
  const planned = new Map<MuscleGroup, number>();
  for (const d of trainingDays) {
    for (const e of dayRoutine.get(d)?.exercises ?? []) {
      for (const m of byId.get(e.exercise_id)?.muscle_groups ?? []) planned.set(m, (planned.get(m) ?? 0) + e.target_sets);
    }
  }
  const covered: CatchUpPlan["covered"] = [];
  const needs = input.behind
    .map((b) => {
      const c = Math.min(b.remaining, planned.get(b.muscle) ?? 0);
      if (c > 0) covered.push({ muscle: b.muscle, sets: c });
      return { muscle: b.muscle, remaining: b.remaining - c };
    })
    .filter((n) => n.remaining > 0);

  // Sets still needed per muscle. An exercise that trains two behind muscles counts toward both.
  const left = new Map(needs.map((n) => [n.muscle, n.remaining]));
  const pieces = needs.reduce((n, x) => n + splitSets(x.remaining).length, 0);
  const scarce = pieces > trainingDays.length * MAX_PER_DAY;
  const alsoOf = new Map<CatchUpAddition, Set<MuscleGroup>>();

  for (const need of needs) {
    let picks = candidates(need.muscle);
    if (scarce) {
      // Short on slots: prefer exercises that also train another muscle that is still behind (stable, so personal order holds on ties).
      const extra = (id: string) => (byId.get(id)?.muscle_groups ?? []).filter((g) => g !== need.muscle && (left.get(g) ?? 0) > 0).length;
      picks = picks.map((id, i) => ({ id, i, n: extra(id) })).sort((a, b) => b.n - a.n || a.i - b.i).map((x) => x.id);
    }
    for (const sets of splitSets(left.get(need.muscle) ?? 0)) {
      // Days whose routine already trains the muscle come first, then free days, then other routines.
      const open = trainingDays
        .map((d, i) => {
          const r = dayRoutine.get(d);
          const has = r?.exercises.some((e) => trains(byId.get(e.exercise_id), need.muscle));
          return { d, i, rank: has ? 0 : r ? 2 : 1, load: added.get(d)!.length };
        })
        .sort((a, b) => a.rank - b.rank || a.load - b.load || a.i - b.i);

      let gave = 0;
      let item: CatchUpAddition | null = null;
      for (const { d } of open) {
        const list = added.get(d)!;
        const mineHere = dayRoutine.get(d)?.exercises.find((e) => trains(byId.get(e.exercise_id), need.muscle) && usable(byId.get(e.exercise_id)));
        // A full day only takes more sets on an exercise it already has for this muscle.
        let id: string | undefined;
        if (list.length >= MAX_PER_DAY) id = list.find((a) => a.muscle === need.muscle && a.sets < MAX_SETS)?.exercise_id;
        else if (mineHere) id = mineHere.exercise_id;
        else {
          // Among the first few fresh picks, prefer equipment the day does not use yet, for variety.
          const fresh = picks.filter((p) => !onDay.get(d)!.has(p) && !list.some((a) => a.exercise_id === p));
          const used = new Set([...onDay.get(d)!, ...list.map((a) => a.exercise_id)].map((x) => byId.get(x)?.equipment));
          id = fresh.slice(0, 3).find((p) => !used.has(byId.get(p)?.equipment)) ?? fresh[0];
        }
        if (!id) continue;
        const prior = list.find((a) => a.exercise_id === id);
        if (prior) {
          if (prior.sets >= MAX_SETS) continue;
          gave = Math.min(sets, MAX_SETS - prior.sets);
          prior.sets += gave;
          item = prior;
        } else {
          gave = sets;
          item = { exercise_id: id, muscle: need.muscle, date: d, sets, reason: "", in_routine: onDay.get(d)!.has(id) };
          list.push(item);
        }
        break;
      }
      if (!item || gave === 0) break;
      // Credit every primary muscle of the exercise that is still behind.
      const also = alsoOf.get(item) ?? new Set<MuscleGroup>();
      for (const g of byId.get(item.exercise_id)?.muscle_groups ?? []) {
        const cur = left.get(g);
        if (cur === undefined || cur <= 0) continue;
        left.set(g, Math.max(0, cur - gave));
        if (g !== need.muscle) also.add(g);
      }
      alsoOf.set(item, also);
      item.reason = reasonFor(need.muscle, [...also]);
    }
  }

  const unmet: CatchUpPlan["unmet"] = needs.map((n) => ({ muscle: n.muscle, sets: left.get(n.muscle) ?? 0 })).filter((u) => u.sets > 0);
  return { trainingDays, additions: trainingDays.flatMap((d) => added.get(d)!), unmet, covered, noSessionsLeft: false };
}

function reasonFor(muscle: MuscleGroup, also: MuscleGroup[]): string {
  return also.length ? `Brings ${muscle} to target, also ${also.join(" and ")}` : `Brings ${muscle} to target`;
}
