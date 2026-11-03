import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDayRoutines, BUILD_SETS, MAX_PER_DAY, type BuildInput } from "../coachBuild";
import { poolByMuscle } from "../pool";
import { knownEvidenceIds } from "../evidence/library";
import { MUSCLE_GROUPS, type MuscleGroup } from "../muscles";
import type { Exercise } from "../exercises";

const CAT = JSON.parse(readFileSync(join(__dirname, "../../data/exercises.json"), "utf8")) as Exercise[];
const BY_ID = new Map(CAT.map((e) => [e.id, e]));

const day = (name: string, muscles: MuscleGroup[]) => ({ name, muscles });
const PPL = { days: [day("Push", ["Chest", "Shoulders", "Triceps"]), day("Pull", ["Lats", "Biceps"]), day("Legs", ["Quads", "Hamstrings", "Glutes", "Calves"])] };

const input = (p: Partial<BuildInput> = {}, favourites: string[] = []): BuildInput => ({
  split: PPL,
  pool: poolByMuscle(favourites, CAT, []),
  catalogue: CAT,
  equipment: [],
  limitations: [],
  dislikedIds: [],
  goalType: "build_muscle",
  ...p,
});

const ids = (plan: ReturnType<typeof buildDayRoutines>) => plan.flatMap((d) => d.items.map((i) => i.exercise_id));

describe("buildDayRoutines", () => {
  it("builds one routine per day that has muscles, with sets and reps", () => {
    const plan = buildDayRoutines(input());
    expect(plan.map((d) => [d.dayIndex, d.name])).toEqual([[0, "Push"], [1, "Pull"], [2, "Legs"]]);
    for (const d of plan) {
      expect(d.items.length).toBeGreaterThan(0);
      for (const i of d.items) expect(i).toMatchObject({ target_sets: BUILD_SETS, target_reps: "8-12" });
    }
  });

  it("every exercise trains a muscle of its day", () => {
    const plan = buildDayRoutines(input());
    plan.forEach((d, n) => {
      for (const i of d.items) {
        expect(PPL.days[n].muscles).toContain(i.muscle);
        expect(BY_ID.get(i.exercise_id)!.muscle_groups).toContain(i.muscle);
      }
    });
  });

  it("takes the user's favourites first and says so", () => {
    const plan = buildDayRoutines(input({}, ["Incline_Dumbbell_Curl", "Barbell_Bench_Press_-_Medium_Grip"]));
    const pull = plan[1].items.find((i) => i.exercise_id === "Incline_Dumbbell_Curl")!;
    expect(pull.why).toBe("Incline Dumbbell Curl is one of your favourites for biceps.");
    expect(plan[0].items.some((i) => i.exercise_id === "Barbell_Bench_Press_-_Medium_Grip")).toBe(true);
  });

  it("fills from the best-ranked exercises when there are no favourites", () => {
    const plan = buildDayRoutines(input());
    expect(plan[0].items.every((i) => /top-ranked/.test(i.why))).toBe(true);
  });

  it("never repeats an exercise in a day or two of the same movement for a muscle", () => {
    for (const d of buildDayRoutines(input({}, ["Barbell_Curl", "Hammer_Curls", "Incline_Dumbbell_Curl"]))) {
      const seen = d.items.map((i) => i.exercise_id);
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it("prefers exercises not used on another day", () => {
    const two = { days: [day("A", ["Biceps"]), day("B", ["Biceps"])] };
    const plan = buildDayRoutines(input({ split: two }));
    const a = new Set(plan[0].items.map((i) => i.exercise_id));
    for (const i of plan[1].items) expect(a.has(i.exercise_id)).toBe(false);
  });

  it("puts compound lifts first and caps a day", () => {
    const big = { days: [day("All", [...MUSCLE_GROUPS])] };
    const plan = buildDayRoutines(input({ split: big }));
    expect(plan[0].items.length).toBeLessThanOrEqual(MAX_PER_DAY);
    const kinds = plan[0].items.map((i) => BY_ID.get(i.exercise_id)!.mechanic === "compound");
    expect(kinds).toEqual([...kinds].sort((a, b) => Number(b) - Number(a)));
  });

  it("uses fewer reps for strength", () => {
    for (const d of buildDayRoutines(input({ goalType: "strength" }))) for (const i of d.items) expect(i.target_reps).toBe("4-6");
  });

  it("skips days that already have a routine, and days with no muscles", () => {
    const plan = buildDayRoutines(input({ skipDays: new Set([1]), split: { days: [...PPL.days, day("Rest", [])] } }));
    expect(plan.map((d) => d.name)).toEqual(["Push", "Legs"]);
  });

  it("respects equipment, limits and the never-suggest list", () => {
    const gear = buildDayRoutines(input({ equipment: ["Dumbbell"] }));
    for (const id of ids(gear)) expect(BY_ID.get(id)!.equipment).toBe("Dumbbell");
    const knee = buildDayRoutines(input({ limitations: ["Knee"] }));
    for (const id of ids(knee)) expect(BY_ID.get(id)!.name).not.toMatch(/lunge|split squat|jump|step.?up|leg extension|hack squat/i);
    const base = ids(buildDayRoutines(input()));
    const skipFirst = buildDayRoutines(input({ dislikedIds: [base[0]] }));
    expect(ids(skipFirst)).not.toContain(base[0]);
    const withFav = buildDayRoutines(input({ dislikedIds: ["Barbell_Curl"] }, ["Barbell_Curl"]));
    expect(ids(withFav)).not.toContain("Barbell_Curl");
  });

  it("attaches research only where the library covers that exact exercise", () => {
    const plan = buildDayRoutines(input({}, ["Barbell_Hip_Thrust", "Seated_Leg_Curl", "Barbell_Curl"]));
    const all = plan.flatMap((d) => d.items);
    expect(all.find((i) => i.exercise_id === "Barbell_Hip_Thrust")!.evidenceIds).toEqual(["glutes-thrust-squat"]);
    expect(all.find((i) => i.exercise_id === "Seated_Leg_Curl")!.evidenceIds).toEqual(["hamstrings-seated-curl"]);
    expect(all.find((i) => i.exercise_id === "Barbell_Curl")!.evidenceIds).toEqual([]);
    for (const i of all) expect(knownEvidenceIds(i.evidenceIds)).toEqual(i.evidenceIds);
  });

  it("is deterministic, does not change its input, and handles an empty split", () => {
    const i = input({}, ["Barbell_Curl"]);
    const before = JSON.stringify([i.split, i.dislikedIds, i.limitations]);
    expect(buildDayRoutines(i)).toEqual(buildDayRoutines(input({}, ["Barbell_Curl"])));
    expect(JSON.stringify([i.split, i.dislikedIds, i.limitations])).toBe(before);
    expect(buildDayRoutines(input({ split: { days: [] } }))).toEqual([]);
  });
});
