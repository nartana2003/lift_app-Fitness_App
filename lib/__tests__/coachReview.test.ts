import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  movementKey,
  REVIEW_DEFAULT_SETS,
  reviewDefaultTarget,
  reviewSetup,
  type ReviewGoals,
  type ReviewInput,
  type ReviewPool,
} from "../coachReview";
import type { Exercise } from "../exercises";
import { defaultTarget, DEFAULT_GOALS, type Experience, type GoalType, type Goals } from "../goals";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "../muscles";
import { poolByMuscle } from "../pool";
import { DEFAULT_SETS } from "../routines";
import type { Split } from "../splits";

const ex = (id: string, name: string, muscles: MuscleGroup[], p: Partial<Exercise> = {}): Exercise => ({
  id,
  name,
  muscle_groups: muscles,
  secondary_groups: [],
  equipment: "Dumbbell",
  category: "strength",
  mechanic: "isolation",
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
  ...p,
});

// Hand-written catalogue.
const squat = ex("squat", "Barbell Squat", ["Quads", "Glutes"], { equipment: "Barbell", mechanic: "compound" });
const legPress = ex("legpress", "Leg Press", ["Quads"], { equipment: "Machine/Cable", mechanic: "compound" });
const legExt = ex("legext", "Leg Extension", ["Quads"], { equipment: "Machine/Cable" });
const gobletSquat = ex("goblet", "Goblet Squat", ["Quads"], { mechanic: "compound" });
const lunge = ex("lunge", "Dumbbell Lunge", ["Quads", "Glutes"], { mechanic: "compound" });
const rdl = ex("rdl", "Romanian Deadlift", ["Hamstrings"], { equipment: "Barbell", mechanic: "compound" });
const legCurl = ex("legcurl", "Lying Leg Curl", ["Hamstrings"], { equipment: "Machine/Cable" });
const hipThrust = ex("hipthrust", "Barbell Hip Thrust", ["Glutes"], { equipment: "Barbell", mechanic: "compound" });
const kickback = ex("kickback", "Cable Kickback", ["Glutes"], { equipment: "Machine/Cable" });
const bridge = ex("bridge", "Glute Bridge", ["Glutes"], { equipment: "Bodyweight" });
const crunch = ex("crunch", "Crunch", ["Abs/Core"], { equipment: "Bodyweight" });
const cableCrunch = ex("cablecrunch", "Cable Crunch", ["Abs/Core"], { equipment: "Machine/Cable" });
const plank = ex("plank", "Plank", ["Abs/Core"], { equipment: "Bodyweight" });
const legRaise = ex("legraise", "Hanging Leg Raise", ["Abs/Core"], { equipment: "Bodyweight" });
const zottman = ex("zottman", "Zottman Curl", ["Biceps"]);
const incline = ex("incline", "Incline Dumbbell Curl", ["Biceps"]);
const hammer = ex("hammer", "Hammer Curl", ["Biceps", "Forearms"]);
const dbCurl = ex("dbcurl", "Dumbbell Curl", ["Biceps"]);
const dbCurl2 = ex("dbcurl2", "Dumbbell Bicep Curl", ["Biceps"]);
const bbCurl = ex("bbcurl", "Barbell Curl", ["Biceps"], { equipment: "Barbell" });
const cableCurl = ex("cablecurl", "Cable Curl", ["Biceps"], { equipment: "Machine/Cable" });
const chinUp = ex("chinup", "Chin-Up", ["Biceps", "Lats"], { equipment: "Bodyweight", mechanic: "compound" });
const pushdown = ex("pushdown", "Triceps Pushdown", ["Triceps"], { equipment: "Machine/Cable" });
const skull = ex("skull", "Lying Triceps Extension", ["Triceps"], { equipment: "Barbell" });
const dips = ex("dips", "Dips", ["Triceps", "Chest"], { equipment: "Bodyweight", mechanic: "compound" });
const ohp = ex("ohp", "Overhead Press", ["Shoulders"], { equipment: "Barbell", mechanic: "compound" });
const lateral = ex("lateral", "Lateral Raise", ["Shoulders"]);
const dbPress = ex("dbpress", "Dumbbell Shoulder Press", ["Shoulders"], { mechanic: "compound" });
const row = ex("row", "Barbell Row", ["Back", "Lats"], { equipment: "Barbell", mechanic: "compound" });
const cableRow = ex("cablerow", "Seated Cable Row", ["Back"], { equipment: "Machine/Cable", mechanic: "compound" });
const dbRow = ex("dbrow", "One-Arm Dumbbell Row", ["Back"], { mechanic: "compound" });
const pulldown = ex("pulldown", "Lat Pulldown", ["Lats"], { equipment: "Machine/Cable", mechanic: "compound" });
const bench = ex("bench", "Bench Press", ["Chest", "Triceps"], { equipment: "Barbell", mechanic: "compound" });
const fly = ex("fly", "Dumbbell Fly", ["Chest"]);
const calf = ex("calf", "Standing Calf Raise", ["Calves"], { equipment: "Machine/Cable" });
const kbSwing = ex("kbswing", "Kettlebell Swing", ["Glutes", "Hamstrings"], { equipment: "Kettlebell", mechanic: "compound" });

const CATALOGUE: Exercise[] = [
  squat, legPress, legExt, gobletSquat, lunge, rdl, legCurl, hipThrust, kickback, bridge,
  crunch, cableCrunch, plank, legRaise, zottman, incline, hammer, dbCurl, dbCurl2, bbCurl, cableCurl, chinUp,
  pushdown, skull, dips, ohp, lateral, dbPress, row, cableRow, dbRow, pulldown, bench, fly, calf, kbSwing,
];

const goals = (p: Partial<ReviewGoals> = {}): ReviewGoals => ({
  goalType: "build_muscle",
  experience: "intermediate",
  sessionsPerWeek: 3,
  focusMuscles: [],
  targets: {},
  ...p,
});

// The user's own setup: legs+glutes+abs, arms+shoulders+back+abs, full body.
const USER_SPLIT: Split = {
  name: "My split",
  days: [
    { name: "Legs", muscles: ["Quads", "Hamstrings", "Glutes", "Abs/Core"] },
    { name: "Upper", muscles: ["Biceps", "Triceps", "Shoulders", "Back", "Abs/Core"] },
    { name: "Full body", muscles: ["Chest", "Back", "Quads", "Glutes", "Shoulders"] },
  ],
};

const USER_POOL: ReviewPool = {
  Quads: ["squat", "legext"],
  Hamstrings: ["rdl"],
  Glutes: ["hipthrust", "kickback", "squat"],
  "Abs/Core": ["crunch", "cablecrunch"],
  Biceps: ["zottman", "incline", "hammer"],
  Triceps: ["pushdown", "skull"],
  Shoulders: ["ohp", "lateral"],
  Back: ["row", "cablerow"],
  Chest: ["bench", "fly"],
};

const input = (p: Partial<ReviewInput> = {}): ReviewInput => ({
  goals: goals(),
  split: USER_SPLIT,
  pool: USER_POOL,
  catalogue: CATALOGUE,
  equipment: [],
  ...p,
});

const codes = (r: ReturnType<typeof reviewSetup>, muscle?: MuscleGroup | null) =>
  r.findings.filter((f) => muscle === undefined || f.muscle === muscle).map((f) => f.code);

const allPoolIds = (pool: ReviewPool) =>
  new Set(Object.values(pool).flatMap((l) => (l ?? []).map((x) => (typeof x === "string" ? x : x.id))));

function expectCleanSuggestions(r: ReturnType<typeof reviewSetup>, pool: ReviewPool, cat = CATALOGUE, equipment: Equipment[] = []) {
  const known = new Set(cat.map((e) => e.id));
  const inPool = allPoolIds(pool);
  const seen = new Set<string>();
  for (const s of r.suggestions) {
    expect(known.has(s.exercise_id)).toBe(true);
    expect(inPool.has(s.exercise_id)).toBe(false);
    expect(seen.has(s.exercise_id)).toBe(false);
    seen.add(s.exercise_id);
    expect(s.exercise.id).toBe(s.exercise_id);
    expect(s.exercise.muscle_groups).toContain(s.muscle);
    if (equipment.length) expect(equipment).toContain(s.exercise.equipment);
    expect(s.reason.length).toBeGreaterThan(0);
    expect(s.reason).not.toMatch(/\n/);
  }
  for (const m of MUSCLE_GROUPS) expect(r.suggestions.filter((s) => s.muscle === m).length).toBeLessThanOrEqual(3);
}

describe("rule baseline", () => {
  it("matches defaultTarget() in lib/goals.ts for every muscle and setting", () => {
    const types: GoalType[] = ["build_muscle", "strength", "general", "fat_loss"];
    const levels: Experience[] = ["beginner", "intermediate", "advanced"];
    for (const goalType of types)
      for (const experience of levels)
        for (const sessionsPerWeek of [1, 2, 3, 4, 5, 6, 7])
          for (const m of MUSCLE_GROUPS) {
            const g: Goals = { ...DEFAULT_GOALS, goalType, experience, sessionsPerWeek, focusMuscles: m === "Chest" ? [] : [m] };
            expect(reviewDefaultTarget(m, g)).toBe(defaultTarget(m, g));
          }
  });

  it("uses the same default sets as lib/routines.ts", () => {
    expect(REVIEW_DEFAULT_SETS).toBe(DEFAULT_SETS);
  });
});

describe("movementKey", () => {
  it("finds the movement and a variation", () => {
    expect(movementKey("Incline Hammer Curls")).toBe("incline curl");
    expect(movementKey("Hammer Curl")).toBe("hammer curl");
    expect(movementKey("Barbell Hip Thrust")).toBe("hip thrust");
    expect(movementKey("Crunches")).toBe("crunch");
    expect(movementKey("Dumbbell Curl")).toBe("curl");
    expect(movementKey("Something Odd")).toBe("odd");
  });
});

describe("reviewSetup: the user's setup", () => {
  it("accepts the Goals type and the MusclePool shape from lib/pool.ts", () => {
    const favs = ["squat", "legext", "rdl", "hipthrust", "kickback", "crunch", "cablecrunch", "zottman", "incline", "hammer"];
    const pool = poolByMuscle(favs, CATALOGUE, []);
    const r = reviewSetup({ goals: { ...DEFAULT_GOALS }, split: USER_SPLIT, pool, catalogue: CATALOGUE, equipment: [] });
    expect(codes(r, "Hamstrings")).toContain("one_exercise");
    expect(codes(r, "Chest")).toContain("no_exercises");
    expectCleanSuggestions(r, pool);
  });

  it("flags Hamstrings with one exercise and suggests others, not the pool's", () => {
    const r = reviewSetup(input());
    const ham = r.findings.find((f) => f.muscle === "Hamstrings" && f.code === "one_exercise");
    expect(ham).toMatchObject({ severity: "info" });
    expect(ham?.message).toContain("Romanian Deadlift");
    const picks = r.suggestions.filter((s) => s.muscle === "Hamstrings").map((s) => s.exercise_id);
    expect(picks.length).toBeGreaterThan(0);
    expect(picks).not.toContain("rdl");
    expectCleanSuggestions(r, USER_POOL);
  });

  it("does not flag the split's day count when it fits the sessions", () => {
    const r = reviewSetup(input());
    expect(codes(r, null)).toEqual([]);
  });

  it("estimates weekly load from picks x sets x times per week", () => {
    const r = reviewSetup(input());
    const quads = r.load.find((l) => l.muscle === "Quads");
    // 2 picks x 3 sets x 2 days (3 sessions over a 3-day split).
    expect(quads).toMatchObject({ splitDays: 2, poolSize: 2, weeklySets: 12, target: 11 });
    const ham = r.load.find((l) => l.muscle === "Hamstrings");
    // 1 pick x 3 sets x 1 day = 3, well below 11.
    expect(ham?.weeklySets).toBe(3);
    const below = r.findings.find((f) => f.muscle === "Hamstrings" && f.code === "below_target");
    expect(below?.message).toContain("below your target of 11");
    expect(codes(r, "Quads")).not.toContain("below_target");
    expect(r.load.map((l) => l.muscle)).toEqual(MUSCLE_GROUPS.filter((m) => USER_SPLIT.days.some((d) => d.muscles.includes(m))));
  });

  it("uses the user's own target over the default", () => {
    const r = reviewSetup(input({ goals: goals({ targets: { Quads: 20 } }) }));
    expect(r.load.find((l) => l.muscle === "Quads")?.target).toBe(20);
    expect(codes(r, "Quads")).toContain("below_target");
  });

  it("is deterministic", () => {
    expect(reviewSetup(input())).toEqual(reviewSetup(input()));
  });
});

describe("reviewSetup: focus muscles", () => {
  it("flags a focus muscle on only one split day", () => {
    const r = reviewSetup(input({ goals: goals({ focusMuscles: ["Hamstrings"] }) }));
    const f = r.findings.filter((x) => x.muscle === "Hamstrings");
    expect(f.map((x) => x.code)).toEqual(["focus_few_exercises", "focus_few_days", "below_target"]);
    expect(f.every((x) => x.severity === "warn")).toBe(true);
    // The focus version replaces the plain one-exercise finding.
    expect(codes(r, "Hamstrings")).not.toContain("one_exercise");
  });

  it("does not flag a focus muscle on two days with two exercises for days or exercises", () => {
    const r = reviewSetup(input({ goals: goals({ focusMuscles: ["Quads"] }) }));
    expect(codes(r, "Quads")).not.toContain("focus_few_days");
    expect(codes(r, "Quads")).not.toContain("focus_few_exercises");
  });

  it("flags a focus muscle no day trains and suggests exercises for it", () => {
    const r = reviewSetup(input({ goals: goals({ focusMuscles: ["Calves"] }) }));
    expect(codes(r, "Calves")).toEqual(["focus_few_exercises", "not_in_split"]);
    expect(r.findings.find((f) => f.code === "not_in_split")?.message).toBe("Calves is a focus muscle but no split day trains it.");
    expect(r.suggestions.filter((s) => s.muscle === "Calves").map((s) => s.exercise_id)).toEqual(["calf"]);
  });

  it("flags a muscle with its own target that no day trains", () => {
    const r = reviewSetup(input({ goals: goals({ targets: { Calves: 8 } }) }));
    expect(r.findings.find((f) => f.muscle === "Calves")).toMatchObject({ code: "not_in_split", severity: "warn" });
  });
});

describe("reviewSetup: day count", () => {
  it("flags more split days than sessions per week", () => {
    const r = reviewSetup(input({ goals: goals({ sessionsPerWeek: 2 }) }));
    const f = r.findings.find((x) => x.code === "too_many_days");
    expect(f).toMatchObject({ muscle: null, severity: "warn" });
    expect(f?.message).toContain("3 days but you train 2 times a week");
  });

  it("scales load down when the split has more days than sessions", () => {
    const r = reviewSetup(input({ goals: goals({ sessionsPerWeek: 1 }) }));
    // 2 picks x 3 sets x (1 session x 2/3 days).
    expect(r.load.find((l) => l.muscle === "Quads")?.weeklySets).toBe(4);
  });

  it("flags too few days when goal muscles are left out and there is room for a day", () => {
    const r = reviewSetup(input({ goals: goals({ sessionsPerWeek: 4, focusMuscles: ["Calves"] }) }));
    const f = r.findings.find((x) => x.code === "too_few_days");
    expect(f?.muscle).toBeNull();
    expect(f?.message).toContain("Calves is on no day");
    expect(codes(r, null)).toEqual(["too_few_days"]);
  });

  it("does not flag too few days when every goal muscle has a day", () => {
    const r = reviewSetup(input({ goals: goals({ sessionsPerWeek: 4 }) }));
    expect(codes(r, null)).toEqual([]);
  });
});

describe("reviewSetup: edge cases", () => {
  it("handles an empty pool: every split muscle has no exercises and gets suggestions", () => {
    const r = reviewSetup(input({ pool: {} }));
    const splitMuscles = MUSCLE_GROUPS.filter((m) => USER_SPLIT.days.some((d) => d.muscles.includes(m)));
    for (const m of splitMuscles) {
      expect(codes(r, m)).toEqual(["no_exercises"]);
      expect(r.suggestions.some((s) => s.muscle === m)).toBe(true);
    }
    expect(r.load.every((l) => l.weeklySets === 0)).toBe(true);
    expect(r.suggestions[0].reason).toMatch(/so it has something in your pool\.$/);
    expectCleanSuggestions(r, {});
  });

  it("handles an empty split", () => {
    const r = reviewSetup(input({ split: { name: "", days: [] }, goals: goals({ focusMuscles: ["Glutes"] }) }));
    expect(r.findings[0]).toMatchObject({ code: "no_split", muscle: null, severity: "warn" });
    expect(codes(r)).not.toContain("not_in_split");
    expect(codes(r)).not.toContain("too_few_days");
    expect(r.load).toEqual([]);
    // Glutes has 3 in the pool, so nothing per muscle.
    expect(codes(r, "Glutes")).toEqual([]);
  });

  it("handles an empty split and empty pool with a focus muscle", () => {
    const r = reviewSetup(input({ split: { name: "", days: [] }, pool: {}, goals: goals({ focusMuscles: ["Glutes"] }) }));
    expect(codes(r)).toEqual(["no_split", "focus_few_exercises"]);
    expect(r.suggestions.every((s) => s.muscle === "Glutes")).toBe(true);
    expect(r.suggestions.length).toBe(3);
  });

  it("returns no findings for a split with nothing on it and no goals", () => {
    const r = reviewSetup(input({ split: { name: "x", days: [{ name: "Rest", muscles: [] }] }, pool: {} }));
    expect(r.findings).toEqual([]);
    expect(r.suggestions).toEqual([]);
  });

  it("ignores unknown pool ids, unknown muscles and duplicates", () => {
    const pool = { Hamstrings: ["rdl", "rdl", "nope"], Bogus: ["squat"] } as unknown as ReviewPool;
    const split = { name: "x", days: [{ name: "A", muscles: ["Hamstrings", "Wings"] }] } as unknown as Split;
    const r = reviewSetup(input({ pool, split, goals: goals({ focusMuscles: ["Wings" as MuscleGroup] }) }));
    expect(r.load).toEqual([expect.objectContaining({ muscle: "Hamstrings", poolSize: 1 })]);
    expect(r.findings.every((f) => f.muscle === null || f.muscle === "Hamstrings")).toBe(true);
    expect(r.suggestions.map((s) => s.exercise_id)).not.toContain("nope");
  });

  it("never suggests an exercise in the pool under another muscle, or twice", () => {
    // Squat is pooled under Glutes only; it must not be suggested for Quads.
    const pool: ReviewPool = { Glutes: ["squat", "hipthrust"] };
    const r = reviewSetup(input({ pool }));
    expect(r.suggestions.map((s) => s.exercise_id)).not.toContain("squat");
    expectCleanSuggestions(r, pool);
  });
});

describe("reviewSetup: suggestions", () => {
  it("honours the equipment filter", () => {
    const equipment: Equipment[] = ["Dumbbell", "Bodyweight"];
    const r = reviewSetup(input({ pool: {}, equipment }));
    expect(r.suggestions.length).toBeGreaterThan(0);
    for (const s of r.suggestions) expect(equipment).toContain(s.exercise.equipment);
    expectCleanSuggestions(r, {}, CATALOGUE, equipment);
    // Hamstrings: RDL (barbell), leg curl (machine) are out; the kettlebell swing too.
    expect(r.suggestions.filter((s) => s.muscle === "Hamstrings")).toEqual([]);
  });

  it("puts compounds first", () => {
    const r = reviewSetup(input({ pool: {} }));
    for (const m of MUSCLE_GROUPS) {
      const kinds = r.suggestions.filter((s) => s.muscle === m).map((s) => s.exercise.mechanic === "compound");
      expect(kinds).toEqual([...kinds].sort((a, b) => Number(b) - Number(a)));
    }
    const quads = r.suggestions.filter((s) => s.muscle === "Quads").map((s) => s.exercise_id);
    expect(r.suggestions.find((s) => s.muscle === "Quads")?.exercise.mechanic).toBe("compound");
    expect(quads.length).toBe(3);
  });

  it("varies the movement instead of near-identical curls", () => {
    const pool: ReviewPool = { ...USER_POOL, Biceps: ["zottman"] };
    const r = reviewSetup(input({ pool }));
    const bi = r.suggestions.filter((s) => s.muscle === "Biceps").map((s) => s.exercise);
    expect(bi.length).toBe(3);
    // Chin-up is a different movement; the curls use different equipment.
    expect(bi.map((e) => e.id)).toContain("chinup");
    expect(new Set(bi.map((e) => e.equipment)).size).toBe(3);
    expect(bi.map((e) => e.id)).not.toContain("dbcurl2");
  });

  it("caps suggestions per muscle", () => {
    const r = reviewSetup(input({ pool: {}, suggestionsPerMuscle: 1 }));
    for (const m of MUSCLE_GROUPS) expect(r.suggestions.filter((s) => s.muscle === m).length).toBeLessThanOrEqual(1);
    expect(reviewSetup(input({ pool: {}, suggestionsPerMuscle: 0 })).suggestions).toEqual([]);
    const big = reviewSetup(input({ pool: {}, suggestionsPerMuscle: 9 }));
    for (const m of MUSCLE_GROUPS) expect(big.suggestions.filter((s) => s.muscle === m).length).toBeLessThanOrEqual(3);
  });

  it("only suggests for muscles with a finding", () => {
    const r = reviewSetup(input());
    const flagged = new Set(r.findings.map((f) => f.muscle));
    for (const s of r.suggestions) expect(flagged.has(s.muscle)).toBe(true);
  });

  it("works on the real catalogue with no repeats, no pool ids and varied movements", () => {
    const real = JSON.parse(readFileSync(path.join(process.cwd(), "public", "exercises.json"), "utf8")) as Exercise[];
    const pool: ReviewPool = { Biceps: [] };
    const r = reviewSetup({ goals: goals({ focusMuscles: ["Biceps", "Glutes"] }), split: USER_SPLIT, pool, catalogue: real, equipment: [] });
    expectCleanSuggestions(r, pool, real);
    for (const m of ["Biceps", "Glutes", "Quads"] as MuscleGroup[]) {
      const list = r.suggestions.filter((s) => s.muscle === m);
      expect(list.length).toBe(3);
      expect(new Set(list.map((s) => movementKey(s.exercise.name))).size).toBe(3);
    }
  });
});
