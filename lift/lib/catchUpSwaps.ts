// Exercises the user picked to replace a catch-up suggestion, kept for the current
// week so they survive the trip to the Exercises tab and back. Browser storage only.
import { MAX_SETS } from "./catchUp";

const KEY = "lift.catchUpSwaps";

/** "date|original exercise id" -> the exercise the user picked instead. */
export type Swaps = Record<string, string>;

export const swapKey = (date: string, exerciseId: string) => `${date}|${exerciseId}`;

export function loadSwaps(week: string): Swaps {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return raw && raw.week === week && raw.swaps && typeof raw.swaps === "object" ? raw.swaps : {};
  } catch {
    return {};
  }
}

export function saveSwap(week: string, date: string, exerciseId: string, pickedId: string) {
  try {
    const swaps = loadSwaps(week);
    // Picking the original back removes the swap.
    if (pickedId === exerciseId) delete swaps[swapKey(date, exerciseId)];
    else swaps[swapKey(date, exerciseId)] = pickedId;
    localStorage.setItem(KEY, JSON.stringify({ week, swaps }));
  } catch {
    // Storage can be unavailable; the swap is then simply not remembered.
  }
}

type Addition = { exercise_id: string; date: string; sets: number; reason: string; in_routine?: boolean; muscle: string };

/**
 * The plan with the user's picks put in place. A swapped item keeps its muscle and
 * sets, remembers the exercise it replaced (`orig`) and, if the pick is already on
 * that day, its sets join that exercise instead of listing it twice.
 */
export function applySwaps<A extends Addition>(additions: A[], swaps: Swaps): (A & { orig?: string })[] {
  const out: (A & { orig?: string })[] = [];
  for (const a of additions) {
    const pick = swaps[swapKey(a.date, a.exercise_id)];
    const item: A & { orig?: string } = pick ? { ...a, exercise_id: pick, orig: a.exercise_id, in_routine: false, reason: `Your pick for ${a.muscle}` } : a;
    // The pick may already be on that day, before or after this item: one entry, sets added up.
    const twin = out.find((o) => o.date === item.date && o.exercise_id === item.exercise_id);
    if (twin) twin.sets = Math.min(MAX_SETS, twin.sets + item.sets);
    else out.push(item);
  }
  return out;
}
