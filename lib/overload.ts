// Rule-based progressive overload suggestion (instant, offline). AI refines it later.

import type { Equipment } from "./muscles";
import { fmtWeight, type Unit } from "./units";

export type LoggedSet = { reps: number; weight: number; rir?: number | null; is_warmup?: boolean };

export type RepRange = { min: number; max: number };

export type Suggestion = {
  sets: number;
  reps: number;
  weight: number;
  reason: string;
};

export function parseRepRange(s: string | undefined, fallback: RepRange = { min: 8, max: 12 }): RepRange {
  if (!s) return fallback;
  const m = s.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  const n = parseInt(s, 10); // "10" or timed "45s"
  return Number.isFinite(n) && n > 0 ? { min: n, max: n } : fallback;
}

export function increment(equipment: Equipment | string): number {
  switch (equipment) {
    case "Barbell":
      return 2.5;
    case "Dumbbell":
    case "Kettlebell":
      return 2;
    case "Machine/Cable":
      return 2.5;
    default:
      return 0; // bodyweight/bands: progress reps instead
  }
}

const roundTo = (x: number, step: number) => (step > 0 ? Math.round(x / step) * step : x);

/**
 * Decide today's target from the last session's working sets.
 * RIR: 0=failure, 1=hard, 2=good, 3=easy+.
 */
export function suggest(last: LoggedSet[], range: RepRange, equipment: Equipment | string): Suggestion | null {
  const work = last.filter((s) => !s.is_warmup && s.reps > 0);
  if (work.length === 0) return null;

  const topWeight = Math.max(...work.map((s) => s.weight));
  const atTop = work.filter((s) => s.weight === topWeight);
  const sets = atTop.length;
  const minReps = Math.min(...atTop.map((s) => s.reps));
  const rirs = atTop.map((s) => s.rir).filter((r): r is number => r != null);
  const allEasy = rirs.length > 0 && rirs.every((r) => r >= 3);
  const anyFailure = rirs.some((r) => r === 0);
  const step = increment(equipment);

  // Missed the bottom of the range, or hit failure early → hold or back off.
  if (minReps < range.min) {
    if (anyFailure && step > 0) {
      const w = roundTo(topWeight * 0.95, step);
      return { sets, reps: range.min, weight: w, reason: `Missed reps at failure last time — drop ~5% to ${w} and rebuild.` };
    }
    return { sets, reps: range.min, weight: topWeight, reason: `Stay at ${topWeight} and aim for ${range.min}+ reps on every set.` };
  }

  // Hit the top of the range on all sets → add weight.
  if (minReps >= range.max) {
    if (step === 0) {
      return { sets, reps: range.max + 1, weight: topWeight, reason: `Hit ${range.max} on every set — add a rep.` };
    }
    const jump = allEasy ? step * 2 : step;
    const w = topWeight + jump;
    return {
      sets,
      reps: range.min,
      weight: w,
      reason: allEasy
        ? `All sets felt easy at ${topWeight} — jump to ${w}.`
        : `Hit ${range.max} on every set — go up to ${w}.`,
    };
  }

  // Inside the range.
  if (allEasy && step > 0) {
    const w = topWeight + step;
    return { sets, reps: Math.max(range.min, minReps - 2), weight: w, reason: `Felt easy — try ${w} for slightly fewer reps.` };
  }
  return {
    sets,
    reps: Math.min(range.max, minReps + 1),
    weight: topWeight,
    reason: `Same weight, add a rep to every set (target ${Math.min(range.max, minReps + 1)}).`,
  };
}

export function formatSets(sets: LoggedSet[], unit: Unit = "kg"): string {
  const work = sets.filter((s) => !s.is_warmup && s.reps > 0);
  if (work.length === 0) return "";
  const top = Math.max(...work.map((s) => s.weight));
  const atTop = work.filter((s) => s.weight === top);
  const reps = atTop.map((s) => s.reps);
  const same = reps.every((r) => r === reps[0]);
  const w = fmtWeight(top, unit);
  return same ? `${atTop.length}×${reps[0]} @ ${w}` : `${reps.join("/")} @ ${w}`;
}
