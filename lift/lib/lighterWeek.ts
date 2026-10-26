// Plateau "Start lighter week" in the live workout. Pure, no I/O.
//
// PlateauCard (components/progress/PlateauCard.tsx) saves the fix the user
// chose under the meta key "plateau_fix_applied" as
// { [exerciseId]: { kind, headline, applied_at, until, deload_percent?, deload_weight? } }.
// While a "deload" record for a lift is still running, the live workout's
// "Today" suggestion for that lift becomes a lighter one. It is opt-in: only
// a record the user started by tapping "Start lighter week" changes anything,
// and the suggestion is still only applied on a tap.
import { increment, type LoggedSet, type RepRange, type Suggestion } from "./overload";
import type { Equipment } from "./muscles";

/** Same key as APPLIED_KEY in components/progress/PlateauCard.tsx (checked by a test). */
export const PLATEAU_APPLIED_KEY = "plateau_fix_applied";
/** Used when an older record has no percent. Same as RULE_DELOAD_PERCENT in lib/ai/plateau-fix.ts. */
export const DEFAULT_LIGHTER_PERCENT = 60;
/** Same bounds as DELOAD_MIN / DELOAD_MAX in lib/ai/plateau-fix.ts. */
export const LIGHTER_MIN_PERCENT = 40;
export const LIGHTER_MAX_PERCENT = 90;
const MAX_WEIGHT_KG = 1_000;

export type LighterWeek = {
  /** Percent of the usual top working weight. */
  percent: number;
  /** Weight in kg saved with the fix, or null (bodyweight, or an older record). */
  weight: number | null;
  /** ISO time the lighter week ends. */
  until: string;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The running lighter week for `exerciseId` from the stored applied-fix map,
 * or null when there is none, it is not a deload, it has ended, it has not
 * started yet, or the record is malformed.
 */
export function activeLighterWeek(applied: unknown, exerciseId: string, now: Date): LighterWeek | null {
  if (!isObj(applied) || !Object.hasOwn(applied, exerciseId)) return null;
  const rec = applied[exerciseId];
  if (!isObj(rec) || rec.kind !== "deload" || typeof rec.until !== "string") return null;
  const until = Date.parse(rec.until);
  if (!Number.isFinite(until) || until <= now.getTime()) return null;
  if (typeof rec.applied_at === "string") {
    const from = Date.parse(rec.applied_at);
    if (Number.isFinite(from) && from > now.getTime()) return null;
  }
  const p = rec.deload_percent;
  const percent =
    typeof p === "number" && Number.isInteger(p) && p >= LIGHTER_MIN_PERCENT && p <= LIGHTER_MAX_PERCENT ? p : DEFAULT_LIGHTER_PERCENT;
  const w = rec.deload_weight;
  const weight = typeof w === "number" && Number.isFinite(w) && w > 0 && w <= MAX_WEIGHT_KG ? w : null;
  return { percent, weight, until: rec.until };
}

const roundTo = (x: number, step: number) => (step > 0 ? Math.round(x / step) * step : x);

/**
 * The lighter "Today" suggestion from the last session's working sets: same
 * number of sets at the top weight, the saved lighter weight (or `percent` of
 * last time's top weight, rounded to the equipment step), never heavier than
 * last time, at the bottom of the rep range. With no weight step (bodyweight,
 * bands) the weight stays and the reps drop to `percent` of the range bottom.
 * Null when last time has no working sets.
 */
export function lighterWeekSuggestion(
  last: LoggedSet[],
  range: RepRange,
  equipment: Equipment | string,
  lw: LighterWeek,
): Suggestion | null {
  const work = last.filter((s) => !s.is_warmup && s.reps > 0);
  if (work.length === 0) return null;
  const top = Math.max(...work.map((s) => s.weight));
  const sets = work.filter((s) => s.weight === top).length;
  const step = increment(equipment);
  const reason = `Lighter week: about ${lw.percent}% of your usual weight. Keep every set easy.`;
  if (step === 0 && lw.weight === null) {
    const reps = Math.max(1, Math.round((range.min * lw.percent) / 100));
    return { sets, reps, weight: top, reason };
  }
  const raw = lw.weight ?? roundTo((top * lw.percent) / 100, step);
  let weight = Math.max(0, Math.min(top, Math.round(raw * 100) / 100));
  // A very light lift can round to nothing; keep one step (never above last time).
  if (weight === 0 && top > 0) weight = step > 0 ? Math.min(top, step) : top;
  return { sets, reps: range.min, weight, reason };
}
