// Data helpers for the history cards on Home (Lyfta-style feed).
import { applySet, bestsFromHistory, emptyBests, prsForNewSets, type Bests, type SetLike } from "./prs";

export type FeedWorkout = {
  id: string;
  started_at: string;
  exercises: { exercise_id: string; sets: SetLike[] }[];
};

/**
 * Records (PRs) per workout id. Replays history oldest first and scores each
 * exercise with prsForNewSets against the bests of every earlier workout, the
 * same rules the live workout uses (no records the first time an exercise is
 * logged). One record per PR type a set earns, like the personal_records rows.
 */
export function recordsByWorkout(workouts: FeedWorkout[]): Map<string, number> {
  const sorted = [...workouts].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const bests = new Map<string, Bests>();
  const out = new Map<string, number>();
  for (const w of sorted) {
    let n = 0;
    for (const e of w.exercises) {
      const prior = bests.get(e.exercise_id) ?? emptyBests();
      const hadHistory = prior.weight > 0 || Object.keys(prior.repsAtWeight).length > 0;
      for (const prs of prsForNewSets(e.sets, prior, hadHistory)) n += prs.length;
      bests.set(e.exercise_id, {
        ...e.sets.reduce(applySet, prior),
        volume: Math.max(prior.volume, bestsFromHistory([e.sets]).volume),
      });
    }
    out.set(w.id, n);
  }
  return out;
}

/** "3 x Bench Press": working sets (all sets if every one is a warm-up) x name. */
export function exerciseCaption(sets: SetLike[], name: string): string {
  const working = sets.filter((s) => !s.is_warmup).length;
  return `${working || sets.length} x ${name}`;
}

export type Thumb = { kind: "image"; src: string } | { kind: "letter"; letter: string };

/** The exercise's first catalogue image, else the first letter of its name for a grey circle. */
export function exerciseThumb(imageUrls: string[] | undefined, name: string): Thumb {
  const src = imageUrls?.find((u) => u.trim());
  if (src) return { kind: "image", src };
  const letter = name.trim().match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?";
  return { kind: "letter", letter };
}
