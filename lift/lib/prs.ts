// Personal-record detection.

export type PrType = "weight" | "reps" | "e1rm" | "volume";

export type SetLike = { reps: number; weight: number; is_warmup?: boolean };

export type Bests = {
  weight: number; // heaviest weight lifted for >=1 rep
  e1rm: number; // best estimated 1RM
  volume: number; // best single-session volume for the exercise
  repsAtWeight: Record<string, number>; // weight -> most reps
};

export const emptyBests = (): Bests => ({ weight: 0, e1rm: 0, volume: 0, repsAtWeight: {} });

/** Epley estimated one-rep max. */
export function e1rm(weight: number, reps: number): number {
  if (reps <= 0 || weight <= 0) return 0;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

export function bestsFromHistory(sessions: SetLike[][]): Bests {
  const b = emptyBests();
  for (const sets of sessions) {
    let vol = 0;
    for (const s of sets) {
      if (s.is_warmup || s.reps <= 0) continue;
      vol += s.reps * s.weight;
      b.weight = Math.max(b.weight, s.weight);
      b.e1rm = Math.max(b.e1rm, e1rm(s.weight, s.reps));
      const k = String(s.weight);
      b.repsAtWeight[k] = Math.max(b.repsAtWeight[k] ?? 0, s.reps);
    }
    b.volume = Math.max(b.volume, vol);
  }
  return b;
}

/** PRs set by one new set, given prior bests. Does not mutate. */
export function setPrs(set: SetLike, bests: Bests): PrType[] {
  if (set.is_warmup || set.reps <= 0 || set.weight <= 0) return [];
  const out: PrType[] = [];
  if (set.weight > bests.weight) out.push("weight");
  const prevReps = bests.repsAtWeight[String(set.weight)];
  if (prevReps !== undefined && set.reps > prevReps) out.push("reps");
  if (e1rm(set.weight, set.reps) > bests.e1rm) out.push("e1rm");
  return out;
}

/** True when this session's volume beats the best previous session. */
export function isVolumePr(sessionSets: SetLike[], bests: Bests): boolean {
  const vol = sessionSets.filter((s) => !s.is_warmup).reduce((a, s) => a + s.reps * s.weight, 0);
  return bests.volume > 0 && vol > bests.volume;
}

export function applySet(bests: Bests, set: SetLike): Bests {
  if (set.is_warmup || set.reps <= 0) return bests;
  const k = String(set.weight);
  return {
    ...bests,
    weight: Math.max(bests.weight, set.weight),
    e1rm: Math.max(bests.e1rm, e1rm(set.weight, set.reps)),
    repsAtWeight: { ...bests.repsAtWeight, [k]: Math.max(bests.repsAtWeight[k] ?? 0, set.reps) },
  };
}

export const PR_LABEL: Record<PrType, string> = {
  weight: "Heaviest weight",
  reps: "Most reps at this weight",
  e1rm: "Best est. 1RM",
  volume: "Best session volume",
};

/**
 * PRs for sets added all at once (quick log), as if each were ticked in
 * order on a fresh exercise card: each set is checked against `bests` plus the
 * sets before it, and the session volume PR goes to the first set that beats
 * the best previous session. Mirrors toggleSetDone in lib/workout.ts, so no
 * celebration when `hadHistory` is false (first time logging the exercise).
 * One entry per input set; does not mutate.
 */
export function prsForNewSets(sets: SetLike[], bests: Bests, hadHistory: boolean): PrType[][] {
  let b = bests;
  let volumeGiven = false;
  const done: SetLike[] = [];
  return sets.map((s) => {
    let prs: PrType[] = [];
    if (!s.is_warmup && s.reps > 0) {
      prs = hadHistory ? setPrs(s, b) : [];
      done.push(s);
      if (hadHistory && !volumeGiven && isVolumePr(done, b)) {
        prs.push("volume");
        volumeGiven = true;
      }
      b = applySet(b, s);
    }
    return prs;
  });
}
