// The user's exercise pool: starred exercises grouped by muscle, which split day
// comes next, and which pool exercises to do today (rotating by how long ago each
// was last done). Pure: no I/O, no React. Callers pass in the favourites, the
// catalogue, the saved equipment, the split and the finished workouts.
import type { Exercise } from "./exercises";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "./muscles";
import type { Split, SplitDay } from "./splits";

/** Starred exercises per muscle. Every muscle group has a key (empty list = no pool). */
export type MusclePool = Record<MuscleGroup, Exercise[]>;

/**
 * The slice of a workout this module needs. `WorkoutDetail` from lib/history.ts
 * fits as is. Only finished workouts (ended_at set) count. When `sets` is given,
 * an exercise counts as done only if it has at least one working (non-warm-up) set.
 */
export type PoolWorkout = {
  started_at: string;
  ended_at: string | null;
  exercises: readonly { exercise_id: string; sets?: readonly { is_warmup?: boolean }[] }[];
};

/**
 * Groups the user's starred exercises by their (primary) muscle groups.
 * - Favourites not in `catalogue` are skipped; duplicates are dropped.
 * - An empty `equipment` list means a full gym (no filter).
 * - Custom exercises are included only if they carry muscle groups (one with none
 *   has nowhere to go, so it naturally drops out).
 * Each muscle's list keeps the favourites' order.
 */
export function poolByMuscle(
  favouriteIds: readonly string[],
  catalogue: readonly Exercise[],
  equipment: readonly Equipment[],
): MusclePool {
  const byId = new Map(catalogue.map((e) => [e.id, e]));
  const allowed = equipment.length ? new Set<string>(equipment) : null;
  const pool = Object.fromEntries(MUSCLE_GROUPS.map((m) => [m, [] as Exercise[]])) as MusclePool;
  const seen = new Set<string>();
  for (const id of favouriteIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const e = byId.get(id);
    if (!e || (allowed && !allowed.has(e.equipment))) continue;
    for (const m of new Set(e.muscle_groups)) if (m in pool) pool[m].push(e);
  }
  return pool;
}

type Done = { time: number; ids: Set<string> };

/** Finished workouts as (time, exercise ids done), newest first. Invalid dates are skipped. */
function finished(workouts: readonly PoolWorkout[]): Done[] {
  const out: Done[] = [];
  for (const w of workouts) {
    if (!w.ended_at) continue;
    const time = Date.parse(w.started_at);
    if (Number.isNaN(time)) continue;
    const ids = new Set<string>();
    for (const x of w.exercises) {
      if (x.sets && !x.sets.some((s) => !s.is_warmup)) continue;
      ids.add(x.exercise_id);
    }
    out.push({ time, ids });
  }
  return out.sort((a, b) => b.time - a.time);
}

export type NextSplitDay = {
  /** 0-based index into split.days. */
  index: number;
  day: SplitDay;
  /** Index of the day the most recent matching workout was, or null (no history, or overridden). */
  lastIndex: number | null;
  /** True when the pick came from `override`. */
  overridden: boolean;
};

/**
 * The split day to train next: the day AFTER the one the most recent finished
 * workout best matches by muscle overlap, cycling back to day 1 after the last.
 *
 * Matching uses the primary muscles of the workout's exercises (looked up in
 * `catalogue`). The best day has the highest overlap relative to the union of
 * the two muscle sets (so a focused "Legs" day beats a big "Full body" day for a
 * legs session), then the larger raw overlap, then the earlier day. A workout
 * that overlaps no day at all (for example only unknown exercises) is passed
 * over for the one before it. With no usable history it returns day 1.
 *
 * `override` (0-based day index) forces the pick when it is a valid index.
 * Returns null when the split has no days.
 */
export function nextSplitDay(
  split: Split,
  workouts: readonly PoolWorkout[],
  catalogue: readonly Exercise[],
  override?: number | null,
): NextSplitDay | null {
  const days = split.days;
  if (days.length === 0) return null;
  if (override != null && Number.isInteger(override) && override >= 0 && override < days.length)
    return { index: override, day: days[override], lastIndex: null, overridden: true };

  const muscles = new Map(catalogue.map((e) => [e.id, e.muscle_groups]));
  for (const w of finished(workouts)) {
    const trained = new Set<MuscleGroup>();
    for (const id of w.ids) for (const m of muscles.get(id) ?? []) trained.add(m);
    if (trained.size === 0) continue;
    let best = -1;
    let bestScore = 0;
    let bestOverlap = 0;
    days.forEach((d, i) => {
      const dm = new Set(d.muscles);
      let overlap = 0;
      for (const m of dm) if (trained.has(m)) overlap++;
      if (overlap === 0) return;
      const score = overlap / (dm.size + trained.size - overlap);
      if (score > bestScore || (score === bestScore && overlap > bestOverlap)) {
        best = i;
        bestScore = score;
        bestOverlap = overlap;
      }
    });
    if (best === -1) continue;
    const index = (best + 1) % days.length;
    return { index, day: days[index], lastIndex: best, overridden: false };
  }
  return { index: 0, day: days[0], lastIndex: null, overridden: false };
}

export type TodayPick = {
  exercise: Exercise;
  /** Whole calendar days since it was last done, or null if never done. */
  lastDoneDaysAgo: number | null;
  /** The day's muscles this pick counts for (an exercise can cover two). */
  muscles: MuscleGroup[];
};

export type TodayPlan = {
  muscles: { muscle: MuscleGroup; picks: TodayPick[] }[];
  /** Day muscles with an empty pool (nothing is invented for them). */
  missing: MuscleGroup[];
  /** Every pick once, in the order it first appears. */
  exercises: TodayPick[];
};

const DAY_MS = 864e5;
const midnight = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const daysBetween = (from: number, to: number) => Math.max(0, Math.round((midnight(to) - midnight(from)) / DAY_MS));
const isCompound = (e: Exercise) => e.mechanic === "compound";

/**
 * For each muscle of `day`, up to `perMuscle` exercises from that muscle's pool.
 *
 * Selection, per muscle, in the day's order:
 * 1. Picks already made for an earlier muscle that are also in this muscle's pool
 *    count towards its quota (one exercise covering two muscles counts for both;
 *    no exercise is repeated across the day).
 * 2. The rest come from unused pool exercises, longest ago first (never done
 *    counts as longest ago). Ties: compound first, then name, then id.
 * 3. Exercises done in the most recent session that trained this muscle come
 *    after every other unused option; they only top up the quota when the rest
 *    run out (so each muscle gets min(perMuscle, pool size) picks).
 *
 * Each muscle's picks are then listed compounds before isolation (stable).
 * A muscle with an empty pool gets no picks and is listed in `missing`.
 *
 * `history` is the finished workouts; `catalogue` (optional) is used to tell
 * which muscles a past session trained when it used exercises outside the pool.
 */
export function suggestToday(input: {
  day: SplitDay;
  pool: MusclePool;
  history: readonly PoolWorkout[];
  perMuscle: number;
  now: Date | number;
  catalogue?: readonly Exercise[];
}): TodayPlan {
  const { day, pool, history } = input;
  const now = typeof input.now === "number" ? input.now : input.now.getTime();
  const per = Number.isFinite(input.perMuscle) ? Math.max(0, Math.floor(input.perMuscle)) : 1;
  const sessions = finished(history).filter((s) => s.time <= now);

  const last = new Map<string, number>();
  for (const s of sessions) for (const id of s.ids) if (!last.has(id)) last.set(id, s.time);

  const muscleOf = new Map<string, readonly MuscleGroup[]>();
  for (const e of input.catalogue ?? []) muscleOf.set(e.id, e.muscle_groups);
  for (const list of Object.values(pool)) for (const e of list) muscleOf.set(e.id, e.muscle_groups);

  /** Exercise ids done in the most recent session that trained `m`. */
  const recentFor = (m: MuscleGroup): Set<string> => {
    for (const s of sessions) {
      const hit = [...s.ids].filter((id) => muscleOf.get(id)?.includes(m));
      if (hit.length) return new Set(hit);
    }
    return new Set();
  };

  const order = (a: Exercise, b: Exercise) =>
    (last.get(a.id) ?? -Infinity) - (last.get(b.id) ?? -Infinity) ||
    Number(isCompound(b)) - Number(isCompound(a)) ||
    a.name.localeCompare(b.name) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const picked = new Map<string, TodayPick>();
  const rows: TodayPlan["muscles"] = [];
  const missing: MuscleGroup[] = [];

  for (const m of [...new Set(day.muscles)]) {
    const list = pool[m] ?? [];
    if (list.length === 0) {
      missing.push(m);
      rows.push({ muscle: m, picks: [] });
      continue;
    }
    const picks: TodayPick[] = [];
    for (const e of list) {
      const p = picked.get(e.id);
      if (p && picks.length < per && !picks.includes(p)) {
        if (!p.muscles.includes(m)) p.muscles.push(m);
        picks.push(p);
      }
    }
    if (picks.length < per) {
      const unused = list.filter((e) => !picked.has(e.id));
      const recent = recentFor(m);
      const fresh = unused.filter((e) => !recent.has(e.id));
      // Fresh options first; top up from last session's only when fresh run out.
      const stale = unused.filter((e) => recent.has(e.id));
      const choose = [...fresh.sort(order), ...stale.sort(order)].slice(0, per - picks.length);
      for (const e of choose) {
        const t = last.get(e.id);
        const p: TodayPick = { exercise: e, lastDoneDaysAgo: t == null ? null : daysBetween(t, now), muscles: [m] };
        picked.set(e.id, p);
        picks.push(p);
      }
    }
    const sorted = picks
      .map((p, i) => ({ p, i }))
      .sort((a, b) => Number(isCompound(b.p.exercise)) - Number(isCompound(a.p.exercise)) || a.i - b.i)
      .map((x) => x.p);
    rows.push({ muscle: m, picks: sorted });
  }

  return { muscles: rows, missing, exercises: [...picked.values()] };
}
