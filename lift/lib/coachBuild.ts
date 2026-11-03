// Build: turns a split into one draft routine per day, from the user's own
// favourites first and then the best-ranked exercises for each muscle. Rule-based
// and deterministic (no AI, no I/O, no React), so it works offline. Each exercise
// carries a plain reason and the research ids that cover it. The user's equipment,
// limits and never-suggest list always apply.
import type { Exercise } from "./exercises";
import type { GoalType } from "./goals";
import type { Equipment, MuscleGroup } from "./muscles";
import { movementKey } from "./coachReview";
import { allowedFor, type Limitation } from "./limitations";
import { evidenceFor, knownEvidenceIds } from "./evidence/library";
import type { MusclePool } from "./pool";
import { suggestForMuscle } from "./suggest";

export type PlanItem = {
  exercise_id: string;
  muscle: MuscleGroup;
  target_sets: number;
  target_reps: string;
  /** One plain sentence on why it is in the routine. */
  why: string;
  /** Evidence Library entries that cover this exact exercise. */
  evidenceIds: string[];
};

export type DayPlan = { dayIndex: number; name: string; items: PlanItem[] };

export type BuildInput = {
  split: { days: readonly { name: string; muscles: readonly MuscleGroup[] }[] };
  /** The user's starred exercises by muscle (lib/pool.ts poolByMuscle). */
  pool: MusclePool;
  catalogue: readonly Exercise[];
  /** Empty = full gym (no filter). */
  equipment: readonly Equipment[];
  limitations: readonly Limitation[];
  dislikedIds: readonly string[];
  goalType: GoalType;
  /** Days that already have a routine; left out. */
  skipDays?: ReadonlySet<number>;
};

export const BUILD_SETS = 3;
export const MAX_PER_DAY = 8;
/** Ranked candidates looked at per muscle. */
const CANDIDATES = 12;

const repsFor = (goal: GoalType) => (goal === "strength" ? "4-6" : "8-12");

/**
 * One draft routine per split day that has muscles and is not skipped. Per muscle it
 * takes two exercises on a short day and one on a long day, favourites first, then the
 * best-ranked ones, never twice in a day, never two of the same movement for a muscle,
 * and preferring exercises not yet used on another day. Compound lifts come first in a
 * day. At most MAX_PER_DAY per day.
 */
export function buildDayRoutines(input: BuildInput): DayPlan[] {
  const gear = input.equipment.length ? new Set<string>(input.equipment) : null;
  const usable = input.catalogue.filter((e) => !gear || gear.has(e.equipment));
  const disliked = new Set(input.dislikedIds);
  const ok = (e: Exercise) => !disliked.has(e.id) && allowedFor(e, input.limitations);
  const usedAnywhere = new Set<string>();

  const plans: DayPlan[] = [];
  input.split.days.forEach((day, dayIndex) => {
    if (input.skipDays?.has(dayIndex) || day.muscles.length === 0) return;
    const perMuscle = day.muscles.length <= 3 ? 2 : 1;
    const inDay = new Set<string>();
    const items: { item: PlanItem; compound: boolean }[] = [];

    for (const muscle of day.muscles) {
      if (items.length >= MAX_PER_DAY) break;
      const favourites = (input.pool[muscle] ?? []).filter(ok);
      const favIds = new Set(favourites.map((e) => e.id));
      const ranked = suggestForMuscle(usable as Exercise[], muscle, CANDIDATES).filter((e) => ok(e) && !favIds.has(e.id));
      const candidates = [...favourites, ...ranked].filter((e) => !inDay.has(e.id));
      // Unused on other days first; the order is otherwise kept.
      const ordered = [...candidates.filter((e) => !usedAnywhere.has(e.id)), ...candidates.filter((e) => usedAnywhere.has(e.id))];
      const moves = new Set<string>();
      let taken = 0;
      for (const e of ordered) {
        if (taken >= perMuscle || items.length >= MAX_PER_DAY) break;
        const key = movementKey(e.name);
        if (moves.has(key)) continue;
        moves.add(key);
        inDay.add(e.id);
        usedAnywhere.add(e.id);
        taken++;
        const name = e.name;
        items.push({
          compound: e.mechanic === "compound",
          item: {
            exercise_id: e.id,
            muscle,
            target_sets: BUILD_SETS,
            target_reps: repsFor(input.goalType),
            why: favIds.has(e.id)
              ? `${name} is one of your favourites for ${muscle.toLowerCase()}.`
              : `${name} is a top-ranked ${e.mechanic === "compound" ? "compound " : ""}exercise for ${muscle.toLowerCase()}.`,
            evidenceIds: knownEvidenceIds(evidenceFor({ exerciseId: e.id }).map((x) => x.id)).slice(0, 2),
          },
        });
      }
    }
    if (items.length === 0) return;
    const sorted = items.map((x, i) => ({ ...x, i })).sort((a, b) => Number(b.compound) - Number(a.compound) || a.i - b.i);
    plans.push({ dayIndex, name: day.name, items: sorted.map((x) => x.item) });
  });
  return plans;
}
