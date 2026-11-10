// Finding a replacement for an exercise mid-workout ("machine busy", "no equipment", "it hurts").
import type { Exercise } from "./exercises";

export type SwapReason = "busy" | "equipment" | "hurts" | "variety" | "difficult" | "discomfort";

export const SWAP_REASONS: { v: SwapReason; label: string }[] = [
  { v: "busy", label: "Machine busy" },
  { v: "equipment", label: "No equipment" },
];

/**
 * Every reason a swap can be asked for. SWAP_REASONS above is what the live workout
 * sheet offers; the Coach also asks for "difficult" and "discomfort".
 */
export const ALL_SWAP_REASONS: readonly SwapReason[] = ["busy", "equipment", "hurts", "variety", "difficult", "discomfort"];

const overlap = (a: readonly string[], b: readonly string[]) => a.filter((x) => b.includes(x)).length;

/**
 * Alternatives that train the same muscle.
 * - "busy" avoids the same piece of equipment (the machine is taken).
 * - "equipment" prefers bodyweight, dumbbells and bands.
 * - "hurts" prefers machines and cables, which are easier to control.
 * - "discomfort" does the same as "hurts" (the Coach also drops movements that load a chosen limit).
 * - "difficult" prefers machines and cables and easier levels.
 */
export function swapOptions(all: Exercise[], target: Exercise, reason: SwapReason, limit = 5): Exercise[] {
  const scored = all
    .filter((e) => e.id !== target.id && overlap(e.muscle_groups, target.muscle_groups) > 0)
    .map((e) => {
      let score = overlap(e.muscle_groups, target.muscle_groups) * 3 + overlap(e.secondary_groups, target.secondary_groups);
      if (e.mechanic && e.mechanic === target.mechanic) score += 1.5;
      if (e.force && e.force === target.force) score += 1;
      if (["strength", "powerlifting"].includes(e.category)) score += 1.5;
      if (e.image_urls.length) score += 0.5;
      score -= Math.max(0, e.name.split(" ").length - 5) * 0.4;

      const sameEquip = e.equipment === target.equipment;
      if (reason === "busy") score += sameEquip ? -4 : 1;
      if (reason === "equipment") score += ["Bodyweight", "Dumbbell", "Bands"].includes(e.equipment) ? 2.5 : -1;
      if (reason === "hurts" || reason === "discomfort") score += e.equipment === "Machine/Cable" ? 2 : 0;
      if (reason === "difficult") score += (e.equipment === "Machine/Cable" ? 2 : 0) + (e.level === "beginner" ? 1.5 : e.level === "expert" ? -1.5 : 0);
      if (reason === "variety") score += sameEquip ? 0.5 : 0;
      return { e, score };
    })
    .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));

  return scored.slice(0, limit).map((s) => s.e);
}
