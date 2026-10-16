// Spotting lifts that have stopped improving.
import { e1rm } from "./prs";

export type SessionPoint = { date: string; sets: { reps: number; weight: number; is_warmup?: boolean }[] };

export type Plateau = {
  exerciseId: string;
  weeks: number;
  bestE1rm: number;
  lastE1rm: number;
  sessions: number;
  advice: string;
};

const WEEK = 7 * 864e5;

const topE1rm = (s: SessionPoint) => {
  const work = s.sets.filter((x) => !x.is_warmup && x.reps > 0);
  return work.length ? Math.max(...work.map((x) => e1rm(x.weight, x.reps))) : 0;
};

/**
 * A lift has plateaued when its best estimated 1RM hasn't improved for `minWeeks`,
 * across at least 3 sessions. Needs a real history, so brand-new exercises never flag.
 */
export function detectPlateau(
  exerciseId: string,
  sessions: SessionPoint[],
  opts: { minWeeks?: number; now?: Date } = {},
): Plateau | null {
  const minWeeks = opts.minWeeks ?? 3;
  const now = opts.now ?? new Date();

  const points = sessions
    .map((s) => ({ t: Date.parse(s.date), v: topE1rm(s) }))
    .filter((p) => Number.isFinite(p.t) && p.v > 0)
    .sort((a, b) => a.t - b.t);
  if (points.length < 3) return null;

  // Only look at the recent stretch; a long break isn't a plateau.
  const last = points[points.length - 1];
  if (now.getTime() - last.t > 3 * WEEK) return null;

  const best = points.reduce((m, p) => (p.v > m.v ? p : m), points[0]);
  const since = points.filter((p) => p.t >= best.t);
  if (since.length < 3) return null;

  const weeks = Math.floor((last.t - best.t) / WEEK);
  if (weeks < minWeeks) return null;
  // A later session that beat the best would have become the best, so nothing has improved since.

  return {
    exerciseId,
    weeks,
    bestE1rm: Math.round(best.v * 10) / 10,
    lastE1rm: Math.round(last.v * 10) / 10,
    sessions: since.length,
    advice: adviceFor(weeks),
  };
}

function adviceFor(weeks: number): string {
  if (weeks >= 6) return "Take a lighter week (about 60% of your usual weight), then build back up.";
  if (weeks >= 4) return "Try a different rep range, or swap in a close variation for a few weeks.";
  return "Add one set, or aim for one more rep per set before adding weight.";
}
