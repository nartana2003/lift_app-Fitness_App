import { describe, expect, it } from "vitest";
import type { Exercise } from "../exercises";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "../muscles";
import { nextSplitDay, poolByMuscle, suggestToday, type PoolWorkout } from "../pool";
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

const zottman = ex("zottman", "Zottman Curl", ["Biceps"]);
const incline = ex("incline", "Incline Dumbbell Curl", ["Biceps"]);
const hammer = ex("hammer", "Hammer Curl", ["Biceps", "Forearms"]);
const squat = ex("squat", "Barbell Squat", ["Quads", "Glutes"], { equipment: "Barbell", mechanic: "compound" });
const legExt = ex("legext", "Leg Extension", ["Quads"], { equipment: "Machine/Cable" });
const hipThrust = ex("hipthrust", "Hip Thrust", ["Glutes"], { equipment: "Barbell", mechanic: "compound" });
const kickback = ex("kickback", "Cable Kickback", ["Glutes"], { equipment: "Machine/Cable" });
const crunch = ex("crunch", "Crunch", ["Abs/Core"], { equipment: "Bodyweight" });
const bench = ex("bench", "Bench Press", ["Chest", "Triceps"], { equipment: "Barbell", mechanic: "compound" });
const row = ex("row", "Barbell Row", ["Back", "Lats"], { equipment: "Barbell", mechanic: "compound" });
const press = ex("press", "Shoulder Press", ["Shoulders"], { mechanic: "compound" });
const customNone = ex("custom-1", "My Thing", [], { equipment: "Other" });
const customBi = ex("custom-2", "Band Curl", ["Biceps"], { equipment: "Bands" });

const CATALOGUE = [zottman, incline, hammer, squat, legExt, hipThrust, kickback, crunch, bench, row, press, customNone, customBi];

const NOW = new Date(2026, 9, 24, 18, 0);
const daysAgo = (n: number, hour = 9) => new Date(2026, 9, 24 - n, hour, 0).toISOString();
const w = (n: number, ids: string[], p: Partial<PoolWorkout> = {}): PoolWorkout => ({
  started_at: daysAgo(n),
  ended_at: daysAgo(n, 10),
  exercises: ids.map((exercise_id) => ({ exercise_id })),
  ...p,
});

const ids = (list: { exercise: Exercise }[]) => list.map((p) => p.exercise.id);
const pool = (favs: string[], equipment: Equipment[] = []) => poolByMuscle(favs, CATALOGUE, equipment);

describe("poolByMuscle", () => {
  it("groups starred exercises by every muscle they train, keeping favourite order", () => {
    const p = pool(["hammer", "zottman", "incline"]);
    expect(p.Biceps.map((e) => e.id)).toEqual(["hammer", "zottman", "incline"]);
    expect(p.Forearms.map((e) => e.id)).toEqual(["hammer"]);
    expect(p.Chest).toEqual([]);
    expect(Object.keys(p).sort()).toEqual([...MUSCLE_GROUPS].sort());
  });

  it("drops unknown ids and duplicates", () => {
    const p = pool(["zottman", "nope", "zottman"]);
    expect(p.Biceps.map((e) => e.id)).toEqual(["zottman"]);
  });

  it("honours the saved equipment; an empty list means a full gym", () => {
    expect(pool(["squat", "legext"], ["Machine/Cable"]).Quads.map((e) => e.id)).toEqual(["legext"]);
    expect(pool(["squat", "legext"], []).Quads.map((e) => e.id)).toEqual(["squat", "legext"]);
  });

  it("includes custom exercises only when they carry muscle groups", () => {
    const p = pool(["custom-1", "custom-2"]);
    expect(p.Biceps.map((e) => e.id)).toEqual(["custom-2"]);
    expect(Object.values(p).flat().some((e) => e.id === "custom-1")).toBe(false);
  });

  it("returns empty lists with no favourites", () => {
    expect(Object.values(pool([])).every((l) => l.length === 0)).toBe(true);
  });
});

const SPLIT: Split = {
  name: "Mine",
  days: [
    { name: "Legs", muscles: ["Quads", "Glutes", "Abs/Core"] },
    { name: "Upper", muscles: ["Biceps", "Shoulders", "Back", "Abs/Core"] },
    { name: "Full body", muscles: ["Chest", "Back", "Quads", "Glutes", "Shoulders", "Biceps", "Abs/Core"] },
  ],
};

describe("nextSplitDay", () => {
  it("returns day 1 with no history", () => {
    const r = nextSplitDay(SPLIT, [], CATALOGUE)!;
    expect(r.index).toBe(0);
    expect(r.day.name).toBe("Legs");
    expect(r.lastIndex).toBeNull();
  });

  it("returns the day after the best match of the most recent workout", () => {
    const r = nextSplitDay(SPLIT, [w(5, ["bench", "row"]), w(2, ["squat", "crunch"])], CATALOGUE)!;
    expect(r.lastIndex).toBe(0);
    expect(r.day.name).toBe("Upper");
  });

  it("prefers the focused day over a big full-body day for the same overlap", () => {
    // squat + hip thrust + crunch hits all 3 Legs muscles and 3 of the full-body ones.
    expect(nextSplitDay(SPLIT, [w(1, ["squat", "hipthrust", "crunch"])], CATALOGUE)!.lastIndex).toBe(0);
    // A real full-body session matches the full-body day.
    expect(nextSplitDay(SPLIT, [w(1, ["bench", "row", "squat", "zottman", "press"])], CATALOGUE)!.lastIndex).toBe(2);
  });

  it("cycles past the last day back to day 1", () => {
    const r = nextSplitDay(SPLIT, [w(1, ["bench", "row", "squat", "zottman", "press", "crunch"])], CATALOGUE)!;
    expect(r.lastIndex).toBe(2);
    expect(r.index).toBe(0);
  });

  it("ignores unfinished workouts and passes over ones that match no day", () => {
    const r = nextSplitDay(
      SPLIT,
      [w(3, ["zottman", "press"]), w(1, ["squat"], { ended_at: null }), w(0, ["unknown-id"])],
      CATALOGUE,
    )!;
    expect(r.lastIndex).toBe(1);
    expect(r.day.name).toBe("Full body");
  });

  it("uses the most recent workout regardless of input order", () => {
    const r = nextSplitDay(SPLIT, [w(1, ["zottman", "press"]), w(4, ["squat"])], CATALOGUE)!;
    expect(r.lastIndex).toBe(1);
  });

  it("can be overridden with a valid day index", () => {
    const r = nextSplitDay(SPLIT, [w(1, ["squat"])], CATALOGUE, 2)!;
    expect(r).toMatchObject({ index: 2, overridden: true });
    expect(r.day.name).toBe("Full body");
    expect(nextSplitDay(SPLIT, [], CATALOGUE, 9)!.overridden).toBe(false);
    expect(nextSplitDay(SPLIT, [], CATALOGUE, -1)!.index).toBe(0);
  });

  it("returns null for an empty split", () => {
    expect(nextSplitDay({ name: "", days: [] }, [w(1, ["squat"])], CATALOGUE)).toBeNull();
  });
});

describe("suggestToday", () => {
  const BI = { name: "Arms", muscles: ["Biceps"] as MuscleGroup[] };
  const biPool = pool(["zottman", "incline", "hammer"]);

  it("user's example: Zottman done last week, so the longer-ago of incline/hammer is suggested", () => {
    const history = [w(7, ["zottman"]), w(14, ["hammer"]), w(21, ["incline"])];
    const r = suggestToday({ day: BI, pool: biPool, history, perMuscle: 1, now: NOW });
    expect(ids(r.muscles[0].picks)).toEqual(["incline"]);
    expect(r.muscles[0].picks[0].lastDoneDaysAgo).toBe(21);

    const flipped = [w(7, ["zottman"]), w(21, ["hammer"]), w(14, ["incline"])];
    const r2 = suggestToday({ day: BI, pool: biPool, history: flipped, perMuscle: 1, now: NOW });
    expect(ids(r2.muscles[0].picks)).toEqual(["hammer"]);
    expect(r2.muscles[0].picks[0].lastDoneDaysAgo).toBe(21);
  });

  it("never picks the exercise from the latest session for that muscle while the pool has another", () => {
    // Zottman is the oldest ever, but it was also done in the most recent biceps session.
    const history = [w(2, ["zottman"]), w(4, ["incline"]), w(6, ["hammer"])];
    const r = suggestToday({ day: BI, pool: biPool, history, perMuscle: 3, now: NOW });
    expect(ids(r.muscles[0].picks)).not.toContain("zottman");
    expect(ids(r.muscles[0].picks)).toEqual(["hammer", "incline"]);
  });

  it("falls back to the latest-session exercise only when it is the whole pool", () => {
    const solo = pool(["zottman"]);
    const r = suggestToday({ day: BI, pool: solo, history: [w(1, ["zottman"])], perMuscle: 2, now: NOW });
    expect(ids(r.muscles[0].picks)).toEqual(["zottman"]);
    expect(r.muscles[0].picks[0].lastDoneDaysAgo).toBe(1);
  });

  it("ranks never-done as longest ago and reports null", () => {
    const r = suggestToday({ day: BI, pool: biPool, history: [w(30, ["incline"]), w(10, ["hammer"])], perMuscle: 1, now: NOW });
    expect(ids(r.muscles[0].picks)).toEqual(["zottman"]);
    expect(r.muscles[0].picks[0].lastDoneDaysAgo).toBeNull();
  });

  it("breaks ties deterministically: compound first, then name", () => {
    const quadPool = pool(["legext", "squat"]);
    const r = suggestToday({ day: { name: "Q", muscles: ["Quads"] }, pool: quadPool, history: [], perMuscle: 1, now: NOW });
    expect(ids(r.muscles[0].picks)).toEqual(["squat"]);
    const r2 = suggestToday({ day: BI, pool: biPool, history: [], perMuscle: 3, now: NOW });
    expect(ids(r2.muscles[0].picks)).toEqual(["hammer", "incline", "zottman"]);
    const r3 = suggestToday({ day: BI, pool: pool(["zottman", "incline", "hammer"].reverse()), history: [], perMuscle: 3, now: NOW });
    expect(ids(r3.muscles[0].picks)).toEqual(ids(r2.muscles[0].picks));
  });

  it("lists compounds before isolation within a muscle", () => {
    const gl = pool(["kickback", "hipthrust"]);
    // Kickback never done (selected first by rotation), hip thrust done long ago; the latest
    // glute session used squats (not starred), so neither pool exercise is held back.
    const history = [w(40, ["hipthrust"]), w(5, ["squat"])];
    const r = suggestToday({ day: { name: "G", muscles: ["Glutes"] }, pool: gl, history, perMuscle: 2, now: NOW, catalogue: CATALOGUE });
    expect(ids(r.muscles[0].picks)).toEqual(["hipthrust", "kickback"]);
  });

  it("reports an empty-pool muscle as missing with no invented picks", () => {
    const r = suggestToday({ day: { name: "Mix", muscles: ["Biceps", "Calves"] }, pool: biPool, history: [], perMuscle: 2, now: NOW });
    expect(r.missing).toEqual(["Calves"]);
    expect(r.muscles.find((m) => m.muscle === "Calves")!.picks).toEqual([]);
    expect(r.muscles.find((m) => m.muscle === "Biceps")!.picks).toHaveLength(2);
  });

  it("returns nothing but missing muscles for an empty pool", () => {
    const r = suggestToday({ day: SPLIT.days[0], pool: pool([]), history: [], perMuscle: 2, now: NOW });
    expect(r.missing).toEqual(["Quads", "Glutes", "Abs/Core"]);
    expect(r.exercises).toEqual([]);
  });

  it("lets one exercise count for two of the day's muscles and never repeats it", () => {
    const p = pool(["hammer", "zottman"]);
    const day = { name: "Arms", muscles: ["Biceps", "Forearms"] as MuscleGroup[] };
    // Hammer curl is the longest ago, so Biceps takes it; it also covers Forearms.
    const r = suggestToday({ day, pool: p, history: [w(3, ["zottman"]), w(20, ["hammer"])], perMuscle: 1, now: NOW });
    expect(ids(r.muscles[0].picks)).toEqual(["hammer"]);
    expect(ids(r.muscles[1].picks)).toEqual(["hammer"]);
    expect(r.exercises).toHaveLength(1);
    expect(r.exercises[0].muscles).toEqual(["Biceps", "Forearms"]);
    expect(r.missing).toEqual([]);
  });

  it("does not reuse an exercise already picked for another muscle to fill a quota", () => {
    const p = pool(["squat", "legext", "hipthrust", "kickback"]);
    const r = suggestToday({ day: SPLIT.days[0], pool: p, history: [], perMuscle: 2, now: NOW });
    const quads = ids(r.muscles[0].picks);
    const glutes = ids(r.muscles[1].picks);
    expect(quads).toEqual(["squat", "legext"]);
    // Squat counts for glutes too, so only one more glute exercise is added.
    expect(glutes).toEqual(["squat", "hipthrust"]);
    expect(ids(r.exercises)).toEqual(["squat", "legext", "hipthrust"]);
  });

  it("caps picks at perMuscle and the pool size", () => {
    const one = suggestToday({ day: BI, pool: biPool, history: [], perMuscle: 1, now: NOW });
    const many = suggestToday({ day: BI, pool: biPool, history: [], perMuscle: 9, now: NOW });
    expect(one.muscles[0].picks).toHaveLength(1);
    expect(many.muscles[0].picks).toHaveLength(3);
  });

  it("ignores unfinished workouts, warm-up-only exercises and future sessions", () => {
    const history: PoolWorkout[] = [
      w(1, ["zottman"], { ended_at: null }),
      { started_at: daysAgo(2), ended_at: daysAgo(2, 10), exercises: [{ exercise_id: "incline", sets: [{ is_warmup: true }] }] },
      w(-3, ["hammer"]),
    ];
    const r = suggestToday({ day: BI, pool: biPool, history, perMuscle: 3, now: NOW });
    expect(r.muscles[0].picks.every((p) => p.lastDoneDaysAgo === null)).toBe(true);
  });

  it("uses the catalogue to see a session trained the muscle with a non-pool exercise", () => {
    // Latest biceps session used the band curl (not starred), so nothing in the pool is excluded:
    // zottman (oldest) is allowed even though it was the pool's last-used biceps exercise.
    const p = pool(["zottman", "incline"]);
    const history = [w(1, ["custom-2"]), w(5, ["zottman"]), w(3, ["incline"])];
    const withCat = suggestToday({ day: BI, pool: p, history, perMuscle: 1, now: NOW, catalogue: CATALOGUE });
    expect(ids(withCat.muscles[0].picks)).toEqual(["zottman"]);
    expect(withCat.muscles[0].picks[0].lastDoneDaysAgo).toBe(5);
  });

  it("counts days by calendar day", () => {
    const late = new Date(2026, 9, 23, 23, 30).toISOString();
    const r = suggestToday({
      day: BI,
      pool: pool(["zottman"]),
      history: [{ started_at: late, ended_at: late, exercises: [{ exercise_id: "zottman" }] }],
      perMuscle: 1,
      now: new Date(2026, 9, 24, 0, 30),
    });
    expect(r.muscles[0].picks[0].lastDoneDaysAgo).toBe(1);
  });
});
