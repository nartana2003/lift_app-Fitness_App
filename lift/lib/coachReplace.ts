// Replacing one exercise: alternatives that train the same muscle, shaped by why the
// user wants out of it and by their equipment, limits and never-suggest list.
// Pure: no I/O, no React. Reuses the swap ranking in lib/swap.ts.
import type { Exercise } from "./exercises";
import type { Equipment } from "./muscles";
import { filterByLimitations, type Limitation } from "./limitations";
import { swapOptions, type SwapReason } from "./swap";

/** What the Replace menu offers, in order. "variety" is the plain Replace. */
export const REPLACE_REASONS: { v: SwapReason; label: string }[] = [
  { v: "variety", label: "Replace" },
  { v: "equipment", label: "Equipment unavailable" },
  { v: "difficult", label: "Too difficult" },
  { v: "discomfort", label: "Causes discomfort" },
];

export type ReplaceOptions = {
  /** Equipment the user has. Empty = no filter. */
  equipment: readonly Equipment[];
  /** Ids to leave out: the exercise itself and the rest of the plan. */
  exclude: readonly string[];
  dislikedIds: readonly string[];
  limitations: readonly Limitation[];
  limit?: number;
};

export type ReplaceResult = {
  options: Exercise[];
  /** Alternatives existed but the limits removed them all: say so instead of showing nothing quietly. */
  emptied: boolean;
};

const POOL = 40;

/**
 * Ranked alternatives for `target`. Leaves out the excluded and disliked ids,
 * exercises outside the user's equipment, and (for "equipment") ones that need the
 * same equipment as the exercise being replaced, unless that is Bodyweight. The
 * chosen limitations always apply, so a replacement never loads a sore area.
 */
export function replaceOptions(all: readonly Exercise[], target: Exercise, reason: SwapReason, o: ReplaceOptions): ReplaceResult {
  const skip = new Set([target.id, ...o.exclude, ...o.dislikedIds]);
  const gear = o.equipment.length ? new Set<string>(o.equipment) : null;
  const pool = all.filter(
    (e) =>
      !skip.has(e.id) &&
      (!gear || gear.has(e.equipment)) &&
      !(reason === "equipment" && e.equipment === target.equipment && target.equipment !== "Bodyweight"),
  );
  const ranked = swapOptions(pool, target, reason, POOL);
  const { allowed, emptied } = filterByLimitations(ranked, o.limitations);
  return { options: allowed.slice(0, o.limit ?? 5), emptied };
}
