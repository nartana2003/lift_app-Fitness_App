import { describe, expect, it } from "vitest";
import { convertWorkouts, estimateDurationSec, parseDuration, parseLyftaDate, stableUuid, summariseExercises, type LyftaWorkout } from "./convert";

// Shape taken from Lyfta's public sandbox feed (note the live field name `excercise_name`).
const sample: LyftaWorkout[] = [
  {
    id: 1001,
    title: "Upper Strength",
    workout_perform_date: "2026-08-20T17:05:00.000Z",
    exercises: [
      {
        exercise_id: 2,
        excercise_name: "Bench Press",
        exercise_type: "weight_reps",
        exercise_rest_time: 180,
        sets: [
          { id: "s1", weight: "80", reps: "5", rir: "2", duration: "", set_type_id: "1", is_completed: true },
          { id: "s2", weight: "90", reps: "3", rir: "1", duration: "", set_type_id: "1", is_completed: true },
          { id: "s3", weight: "90", reps: "3", rir: "", duration: "", set_type_id: "1", is_completed: false },
          { id: "s4", weight: "", reps: "", rir: "", duration: "", set_type_id: "1", is_completed: false },
        ],
      },
      {
        exercise_id: 7,
        excercise_name: "Plank",
        exercise_type: "duration",
        sets: [{ id: "p1", weight: "", reps: "", duration: "60", is_completed: true }],
      },
      { exercise_id: 9, excercise_name: "Mystery Machine", sets: [{ id: "m1", weight: "10", reps: "10", is_completed: true }] },
    ],
  },
];

describe("stableUuid", () => {
  it("is deterministic, unique per input and UUID-shaped", () => {
    expect(stableUuid("lyfta:1")).toBe(stableUuid("lyfta:1"));
    expect(stableUuid("lyfta:1")).not.toBe(stableUuid("lyfta:2"));
    expect(stableUuid("lyfta:1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("summariseExercises", () => {
  it("counts completed sets per distinct exercise", () => {
    const s = summariseExercises(sample);
    expect(s.find((x) => x.name === "Bench Press")?.sets).toBe(3); // the empty set doesn't count
    expect(s).toHaveLength(3);
  });
});

describe("convertWorkouts", () => {
  const mapping = { "2": "Barbell_Bench_Press", "7": "Plank" };

  it("keeps every set with reps (even ones Lyfta flags as not completed), skips empty and unmapped", () => {
    const r = convertWorkouts(sample, mapping, "kg");
    expect(r.workouts).toHaveLength(1);
    expect(r.workouts[0]).toMatchObject({ notes: "Upper Strength", routine_id: null });
    expect(r.workout_exercises.map((e) => e.exercise_id)).toEqual(["Barbell_Bench_Press", "Plank"]);

    const bench = r.sets.filter((s) => s.workout_exercise_id === r.workout_exercises[0].id);
    expect(bench.map((s) => [s.weight, s.reps, s.rir])).toEqual([[80, 5, 2], [90, 3, 1], [90, 3, null]]);
    expect(r.skippedSets).toBe(2); // the empty bench set + the unmapped "Mystery Machine" set
  });

  it("uses a timed set's seconds as reps", () => {
    const r = convertWorkouts(sample, mapping, "kg");
    const plank = r.sets.find((s) => s.workout_exercise_id === r.workout_exercises[1].id);
    expect(plank).toMatchObject({ reps: 60, weight: 0 });
  });

  it("converts pounds to kg and clamps effort to 0–3", () => {
    const w: LyftaWorkout[] = [{ ...sample[0], exercises: [{ exercise_id: 2, excercise_name: "Bench", sets: [{ id: "a", weight: "225", reps: "5", rir: "7", is_completed: true }] }] }];
    const s = convertWorkouts(w, { "2": "x" }, "lb").sets[0];
    expect(s.weight).toBeCloseTo(102.06, 1);
    expect(s.rir).toBe(3);
  });

  it("re-importing gives identical ids (so nothing duplicates)", () => {
    const a = convertWorkouts(sample, mapping, "kg");
    const b = convertWorkouts(sample, mapping, "kg");
    expect(a.workouts[0].id).toBe(b.workouts[0].id);
    expect(a.sets.map((s) => s.id)).toEqual(b.sets.map((s) => s.id));
    expect(new Set(a.sets.map((s) => s.id)).size).toBe(a.sets.length);
  });

  it("drops workouts with nothing usable", () => {
    expect(convertWorkouts(sample, {}, "kg").workouts).toHaveLength(0);
  });

  it("estimates a duration of at least 10 minutes", () => {
    expect(estimateDurationSec(sample[0])).toBeGreaterThanOrEqual(600);
    expect(estimateDurationSec({ id: 1, workout_perform_date: "2026-01-01", exercises: [] })).toBe(600);
  });
});

describe("dates and durations", () => {
  it("reads Lyfta's zone-less timestamps as UTC and ISO strings as given", () => {
    expect(parseLyftaDate("2026-10-08 08:28:46").toISOString()).toBe("2026-10-08T08:28:46.000Z");
    expect(parseLyftaDate("2026-08-20T17:05:00.000Z").toISOString()).toBe("2026-08-20T17:05:00.000Z");
    expect(parseLyftaDate("2026-08-20T17:05:00+10:00").toISOString()).toBe("2026-08-20T07:05:00.000Z");
  });

  it("parses HH:MM:SS durations", () => {
    expect(parseDuration("01:14:08")).toBe(4448);
    expect(parseDuration("74:08")).toBe(4448);
    expect(parseDuration(600)).toBe(600);
    expect(parseDuration("")).toBe(0);
    expect(parseDuration(undefined)).toBe(0);
  });

  it("uses Lyfta's real duration when present, otherwise estimates", () => {
    const w: LyftaWorkout = {
      id: 5,
      workout_perform_date: "2026-10-08 08:28:46",
      workout_duration: "01:14:08",
      exercises: [{ exercise_id: 1, excercise_name: "X", sets: [{ id: "a", weight: "10", reps: "10", is_completed: false }] }],
    };
    const r = convertWorkouts([w], { "1": "x" }, "kg").workouts[0];
    expect((Date.parse(r.ended_at!) - Date.parse(r.started_at)) / 1000).toBe(4448);
    const est = convertWorkouts([{ ...w, workout_duration: undefined }], { "1": "x" }, "kg").workouts[0];
    expect((Date.parse(est.ended_at!) - Date.parse(est.started_at)) / 1000).toBe(600);
  });
});
