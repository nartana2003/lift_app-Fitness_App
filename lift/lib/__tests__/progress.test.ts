import { describe, expect, it } from "vitest";
import {
  dayKey,
  exerciseSeries,
  filterByRange,
  isoWeek,
  monthGrid,
  periodStats,
  weeklyBuckets,
  weeksForRange,
  workoutTitle,
  type WorkoutLite,
} from "../progress";

const w = (id: string, iso: string, volume: number, mins = 60, sets = 3, exercise = "bench"): WorkoutLite => ({
  id,
  started_at: iso,
  ended_at: new Date(Date.parse(iso) + mins * 60000).toISOString(),
  notes: null,
  volume,
  setCount: sets,
  exercises: [{ exercise_id: exercise, sets: Array.from({ length: sets }, () => ({ reps: 10, weight: 50 })) }],
});

// Local-time ISO helper so tests don't depend on the machine's timezone.
const at = (y: number, m: number, d: number, h = 18) => new Date(y, m - 1, d, h).toISOString();
const NOW = new Date(2026, 9, 14, 12); // Wed 14 Oct 2026

describe("weekly buckets", () => {
  const ws = [
    w("a", at(2026, 10, 12), 1000, 60), // Mon this week
    w("b", at(2026, 10, 14), 500, 30), // Wed this week
    w("c", at(2026, 10, 5), 2000, 90), // last week
  ];

  it("sums volume, counts workouts, and totals duration in minutes per week", () => {
    const vol = weeklyBuckets(ws, 3, "volume", 1, NOW);
    expect(vol.map((b) => b.value)).toEqual([0, 2000, 1500]);
    expect(weeklyBuckets(ws, 3, "workouts", 1, NOW).map((b) => b.value)).toEqual([0, 1, 2]);
    expect(weeklyBuckets(ws, 3, "duration", 1, NOW).map((b) => b.value)).toEqual([0, 90, 90]);
  });

  it("labels weeks oldest → newest", () => {
    const b = weeklyBuckets(ws, 2, "volume", 1, NOW);
    expect(b[1].label).toBe("12 Oct - 18 Oct");
    expect(b[0].label).toBe("5 Oct - 11 Oct");
  });

  it("'all time' spans from the first workout", () => {
    const old = [w("x", at(2026, 8, 3), 1)];
    expect(weeksForRange("all", old, 1, NOW)).toBe(11);
    expect(weeksForRange("all", [], 1, NOW)).toBe(5);
    expect(weeksForRange("3m", old, 1, NOW)).toBe(13);
  });
});

describe("period stats", () => {
  it("credits working sets to muscles and ignores warm-ups", () => {
    const x = w("a", at(2026, 10, 12), 1500, 60, 3, "bench");
    x.exercises[0].sets.push({ reps: 15, weight: 20, is_warmup: true });
    const s = periodStats([x], new Date(2026, 9, 12), new Date(2026, 9, 19), (id) => (id === "bench" ? ["Chest", "Triceps"] : []));
    expect(s.sessions).toBe(1);
    expect(s.sets_by_muscle).toEqual({ Chest: 3, Triceps: 3 });
    expect(s.duration_sec).toBe(3600);
    expect(s.volume).toBe(1500);
  });

  it("excludes workouts outside the range", () => {
    const s = periodStats([w("a", at(2026, 10, 5), 1)], new Date(2026, 9, 12), new Date(2026, 9, 19), () => ["Chest"]);
    expect(s.sessions).toBe(0);
    expect(s.sets_by_muscle).toEqual({});
  });
});

describe("exercise series", () => {
  const sessions = [
    { workout: { started_at: at(2026, 10, 8) }, sets: [{ reps: 10, weight: 60 }, { reps: 8, weight: 65 }] },
    { workout: { started_at: at(2026, 9, 1) }, sets: [{ reps: 10, weight: 50 }, { reps: 5, weight: 100, is_warmup: true }] },
  ];

  it("one point per session, oldest first, warm-ups ignored", () => {
    expect(exerciseSeries(sessions, "weight").map((p) => p.value)).toEqual([50, 65]);
    expect(exerciseSeries(sessions, "reps").map((p) => p.value)).toEqual([10, 10]);
    expect(exerciseSeries(sessions, "volume").map((p) => p.value)).toEqual([500, 1120]);
    expect(exerciseSeries(sessions, "e1rm").map((p) => p.value)).toEqual([66.7, 82.3]);
  });

  it("filters by range", () => {
    const pts = exerciseSeries(sessions, "weight");
    expect(filterByRange(pts, "1m", NOW)).toHaveLength(1);
    expect(filterByRange(pts, "all", NOW)).toHaveLength(2);
  });
});

describe("calendar + titles", () => {
  it("builds whole weeks for a month", () => {
    const oct = monthGrid(2026, 9, 1); // October 2026 starts on a Thursday
    expect(oct).toHaveLength(35);
    expect(dayKey(oct[0])).toBe("2026-09-28");
    expect(dayKey(oct[34])).toBe("2026-11-01");
    const octSun = monthGrid(2026, 9, 0);
    expect(dayKey(octSun[0])).toBe("2026-09-27");
  });

  it("ISO week numbers", () => {
    expect(isoWeek(new Date(2026, 9, 14))).toBe(42);
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1);
  });

  it("titles by time of day, unless named", () => {
    expect(workoutTitle({ started_at: at(2026, 10, 8, 7), notes: null })).toBe("Morning workout");
    expect(workoutTitle({ started_at: at(2026, 10, 8, 14), notes: null })).toBe("Afternoon workout");
    expect(workoutTitle({ started_at: at(2026, 10, 8, 19), notes: null })).toBe("Evening workout");
    expect(workoutTitle({ started_at: at(2026, 10, 8, 19), notes: "Leg day" })).toBe("Leg day");
  });
});
