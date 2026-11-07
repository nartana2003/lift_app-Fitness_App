import { describe, expect, it } from "vitest";
import { searchExercises, type Exercise } from "../exercises";

// Issue #7: the Exercises tab has a Cardio filter, like Lyfta.
const ex = (id: string, over: Partial<Exercise> = {}): Exercise => ({
  id,
  name: id,
  muscle_groups: ["Chest"],
  secondary_groups: [],
  equipment: "Barbell",
  category: "strength",
  mechanic: null,
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
  ...over,
});

const BENCH = ex("Bench Press");
const SQUAT = ex("Squat", { muscle_groups: ["Quads"] });
const BIKE = ex("Recumbent Bike", { muscle_groups: ["Quads"], equipment: "Machine/Cable", category: "cardio" });
const RUN = ex("Running, Treadmill", { muscle_groups: ["Quads"], equipment: "Machine/Cable", category: "cardio" });
const ALL = [BENCH, SQUAT, BIKE, RUN];

describe("searchExercises category", () => {
  it("returns only cardio exercises for the cardio category", () => {
    expect(searchExercises(ALL, { category: "cardio" })).toEqual([BIKE, RUN]);
  });

  it("returns nothing when no exercise has the category", () => {
    expect(searchExercises([BENCH, SQUAT], { category: "cardio" })).toEqual([]);
  });

  it("combines with search text and equipment", () => {
    expect(searchExercises(ALL, { category: "cardio", q: "run" })).toEqual([RUN]);
    expect(searchExercises(ALL, { category: "cardio", equipment: ["Barbell"] })).toEqual([]);
    expect(searchExercises(ALL, { category: "cardio", equipment: ["Machine/Cable"] })).toEqual([BIKE, RUN]);
  });

  it("no category keeps every exercise, so existing filters are unchanged", () => {
    expect(searchExercises(ALL, {})).toEqual(ALL);
    expect(searchExercises(ALL, { muscle: "Chest" })).toEqual([BENCH]);
    expect(searchExercises(ALL, { muscle: "Quads" })).toEqual([SQUAT, BIKE, RUN]);
    expect(searchExercises(ALL, { q: "bike" })).toEqual([BIKE]);
  });
});
