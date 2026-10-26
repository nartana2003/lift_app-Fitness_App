// Picking sensible exercises for a muscle group (used by "catch up" and, later, swaps).
import type { Exercise } from "./exercises";

const GYM = new Set(["strength", "powerlifting", "olympic weightlifting"]);

/** Machines and free weights first; odd variations and bodyweight filler last. */
function rank(e: Exercise): number {
  let score = 0;
  if (GYM.has(e.category)) score += 3;
  if (e.mechanic === "compound") score += 2;
  if (["Machine/Cable", "Barbell", "Dumbbell"].includes(e.equipment)) score += 2;
  if (e.equipment === "Other") score -= 2;
  if (e.level === "beginner") score += 1;
  if (e.image_urls.length > 0) score += 1;
  // Long names are usually obscure variations ("Bent Over Dumbbell Rear Delt Raise With Head On Bench").
  score -= Math.max(0, e.name.split(" ").length - 4) * 0.5;
  return score;
}

/** Best `limit` exercises whose primary muscle is `muscle`, best first. */
export function suggestForMuscle(all: Exercise[], muscle: string, limit = 3): Exercise[] {
  return all
    .filter((e) => e.muscle_groups.includes(muscle as never))
    .sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
