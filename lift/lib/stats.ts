// Pure helpers for weekly/monthly snapshots. Kept free of I/O so they're easy to test.

export type PeriodStats = {
  sessions: number;
  duration_sec: number;
  volume: number;
  sets_by_muscle: Record<string, number>;
  workout_days: string[];
};

export type Delta = { current: number; previous: number; diff: number; pct: number | null };

export function delta(current: number, previous: number): Delta {
  const diff = current - previous;
  const pct = previous === 0 ? (current === 0 ? 0 : null) : (diff / previous) * 100;
  return { current, previous, diff, pct };
}

export function compare(current: PeriodStats, previous: PeriodStats) {
  return {
    sessions: delta(current.sessions, previous.sessions),
    duration: delta(current.duration_sec, previous.duration_sec),
    volume: delta(current.volume, previous.volume),
    musclesHit: Object.keys(current.sets_by_muscle).length,
  };
}

/** 00:00 local time of the first day of the week containing `d` (weekStart: 1 = Monday, 0 = Sunday). */
export function startOfWeek(d: Date, weekStart: 0 | 1 = 1): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (x.getDay() - weekStart + 7) % 7;
  x.setDate(x.getDate() - day);
  return x;
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/** Days remaining in the week including today. */
export function daysLeftInWeek(now: Date, weekStart: 0 | 1 = 1): number {
  return 7 - ((now.getDay() - weekStart + 7) % 7);
}

export type GoalStatus = "met" | "partial" | "none";

export type GoalProgress = {
  muscle: string;
  done: number;
  target: number;
  remaining: number;
  status: GoalStatus;
};

export function goalProgress(
  setsByMuscle: Record<string, number>,
  targets: Record<string, number>,
): GoalProgress[] {
  return Object.entries(targets)
    .filter(([, target]) => target > 0)
    .map(([muscle, target]) => {
      const done = setsByMuscle[muscle] ?? 0;
      const remaining = Math.max(0, target - done);
      const status: GoalStatus = done >= target ? "met" : done > 0 ? "partial" : "none";
      return { muscle, done, target, remaining, status };
    })
    .sort((a, b) => b.remaining - a.remaining);
}

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ---------- skipped / moved days for the AI recap ----------

/** Structural subset of SkipStats (lib/progress.ts) that the recap needs. */
export type SkipCounts<R extends string = string> = {
  skipped: number;
  moved: number;
  topReasons: { reason: R; count: number }[];
};

export type RecapSkipFields<R extends string = string> = {
  skipped: number;
  moved: number;
  /** Reason -> days. Never sums to more than skipped + moved. */
  skip_reasons: Partial<Record<R, number>>;
};

/** Most skipped or moved days in one period. Same as MAX_DAYS_OFF in lib/ai/summary.ts. */
export const RECAP_MAX_DAYS_OFF = 31;

/**
 * Skip stats in the shape the weekly/monthly recap route accepts: whole
 * counts clamped to [0, max], repeated reasons merged, zero counts dropped,
 * and reason counts trimmed (in the given order) so they never total more
 * than skipped + moved, which the route would reject.
 */
export function recapSkipFields<R extends string>(s: SkipCounts<R>, max = RECAP_MAX_DAYS_OFF): RecapSkipFields<R> {
  const clamp = (n: number) => Math.max(0, Math.min(max, Math.floor(Number.isFinite(n) ? n : 0)));
  const skipped = clamp(s.skipped);
  const moved = clamp(s.moved);
  let left = skipped + moved;
  // A Map, so any reason string (even "constructor" or "__proto__") is just a key.
  const merged = new Map<R, number>();
  for (const { reason, count } of s.topReasons) {
    const n = Math.min(clamp(count), left);
    if (n <= 0) continue;
    merged.set(reason, Math.min(max, (merged.get(reason) ?? 0) + n));
    left -= n;
  }
  // Object.fromEntries defines own properties, so "__proto__" never touches the prototype.
  const skip_reasons = Object.fromEntries(merged) as Partial<Record<R, number>>;
  return { skipped, moved, skip_reasons };
}
