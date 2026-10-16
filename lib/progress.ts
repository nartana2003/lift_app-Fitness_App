// Pure calculations behind the Progress tab (no I/O, easy to test).
import { e1rm } from "./prs";
import { addDays, startOfWeek, type PeriodStats } from "./stats";

type SetLite = { reps: number; weight: number; is_warmup?: boolean };

/** Structural subset of WorkoutDetail that these helpers need. */
export type WorkoutLite = {
  id: string;
  started_at: string;
  ended_at: string | null;
  notes: string | null;
  volume: number;
  setCount: number;
  exercises: { exercise_id: string; sets: SetLite[] }[];
};

export type Metric = "volume" | "workouts" | "duration";

export const durationSec = (w: { started_at: string; ended_at: string | null }) =>
  w.ended_at ? Math.max(0, (Date.parse(w.ended_at) - Date.parse(w.started_at)) / 1000) : 0;

/** "Morning workout" / "Afternoon workout" / "Evening workout" unless the workout has a name. */
export function workoutTitle(w: { started_at: string; notes: string | null }): string {
  if (w.notes) return w.notes;
  const h = new Date(w.started_at).getHours();
  return h < 12 ? "Morning workout" : h < 17 ? "Afternoon workout" : "Evening workout";
}

// ---------- weekly bar chart ----------

export type Bucket = { start: Date; label: string; value: number };

const dayMonth = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export function weeklyBuckets(
  workouts: WorkoutLite[],
  weeks: number,
  metric: Metric,
  weekStart: 0 | 1 = 1,
  now = new Date(),
): Bucket[] {
  const thisWeek = startOfWeek(now, weekStart);
  const out: Bucket[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(thisWeek, -7 * i);
    const end = addDays(start, 7);
    const inWeek = workouts.filter((w) => {
      const t = Date.parse(w.started_at);
      return t >= start.getTime() && t < end.getTime();
    });
    const value =
      metric === "workouts"
        ? inWeek.length
        : metric === "volume"
          ? inWeek.reduce((a, w) => a + w.volume, 0)
          : inWeek.reduce((a, w) => a + durationSec(w), 0) / 60; // minutes
    out.push({ start, label: `${dayMonth(start)} - ${dayMonth(addDays(end, -1))}`, value });
  }
  return out;
}

export const RANGES = [
  { key: "1m", label: "1 Month", weeks: 5 },
  { key: "3m", label: "3 Months", weeks: 13 },
  { key: "6m", label: "6 Months", weeks: 26 },
  { key: "1y", label: "1 Year", weeks: 52 },
  { key: "all", label: "All time", weeks: 0 },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];

export function weeksForRange(range: RangeKey, workouts: WorkoutLite[], weekStart: 0 | 1 = 1, now = new Date()): number {
  const r = RANGES.find((x) => x.key === range)!;
  if (r.weeks > 0) return r.weeks;
  if (workouts.length === 0) return 5;
  const earliest = Math.min(...workouts.map((w) => Date.parse(w.started_at)));
  const span = Math.ceil((startOfWeek(now, weekStart).getTime() - startOfWeek(new Date(earliest), weekStart).getTime()) / (7 * 864e5)) + 1;
  return Math.max(5, span);
}

// ---------- week / month snapshot ----------

/** Totals for workouts in [from, to). Sets are credited to the exercise's primary muscle groups. */
export function periodStats(
  workouts: WorkoutLite[],
  from: Date,
  to: Date,
  muscleOf: (exerciseId: string) => string[],
): PeriodStats {
  const inRange = workouts.filter((w) => {
    const t = Date.parse(w.started_at);
    return t >= from.getTime() && t < to.getTime();
  });
  const sets: Record<string, number> = {};
  for (const w of inRange)
    for (const e of w.exercises)
      for (const s of e.sets) {
        if (s.is_warmup) continue;
        for (const m of muscleOf(e.exercise_id)) sets[m] = (sets[m] ?? 0) + 1;
      }
  return {
    sessions: inRange.length,
    duration_sec: inRange.reduce((a, w) => a + durationSec(w), 0),
    volume: inRange.reduce((a, w) => a + w.volume, 0),
    sets_by_muscle: sets,
    workout_days: [...new Set(inRange.map((w) => w.started_at.slice(0, 10)))],
  };
}

// ---------- per-exercise charts ----------

export type ExerciseMetric = "e1rm" | "weight" | "volume" | "reps";
export type SeriesPoint = { date: string; value: number };

/** One point per session, oldest → newest. Warm-ups ignored. */
export function exerciseSeries(
  sessions: { workout: { started_at: string }; sets: SetLite[] }[],
  metric: ExerciseMetric,
): SeriesPoint[] {
  const pts: SeriesPoint[] = [];
  for (const s of sessions) {
    const work = s.sets.filter((x) => !x.is_warmup && x.reps > 0);
    if (!work.length) continue;
    const value =
      metric === "e1rm"
        ? Math.max(...work.map((x) => e1rm(x.weight, x.reps)))
        : metric === "weight"
          ? Math.max(...work.map((x) => x.weight))
          : metric === "volume"
            ? work.reduce((a, x) => a + x.reps * x.weight, 0)
            : Math.max(...work.map((x) => x.reps));
    pts.push({ date: s.workout.started_at, value });
  }
  return pts.sort((a, b) => a.date.localeCompare(b.date));
}

export function filterByRange<T extends { date: string }>(pts: T[], range: RangeKey, now = new Date()): T[] {
  const r = RANGES.find((x) => x.key === range)!;
  if (r.weeks === 0) return pts;
  const since = now.getTime() - r.weeks * 7 * 864e5;
  return pts.filter((p) => Date.parse(p.date) >= since);
}

// ---------- month calendar ----------

/** Dates to draw for a month view: whole weeks, starting on `weekStart`. */
export function monthGrid(year: number, month: number, weekStart: 0 | 1 = 1): Date[] {
  const first = new Date(year, month, 1);
  const start = startOfWeek(first, weekStart);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lead = Math.round((first.getTime() - start.getTime()) / 864e5);
  const weeks = Math.ceil((lead + daysInMonth) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
}

export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** ISO week number (1–53) of a date. */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
}
