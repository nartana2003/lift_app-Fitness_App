import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../offline/db";
import { REPLACE_REASONS, replaceOptions } from "../coachReplace";
import { DEFAULT_GOALS, dislikeExercise, MAX_DISLIKED, normalizeGoals, saveGoals, undislikeExercise, type Goals } from "../goals";
import { ALL_SWAP_REASONS, SWAP_REASONS, swapOptions } from "../swap";
import type { Exercise } from "../exercises";
import type { Equipment, MuscleGroup } from "../muscles";

const ex = (id: string, name: string, equipment: Equipment, over: Partial<Exercise> = {}): Exercise => ({
  id,
  name,
  muscle_groups: ["Biceps"] as MuscleGroup[],
  secondary_groups: [],
  equipment,
  category: "strength",
  mechanic: "isolation",
  force: "pull",
  level: "intermediate",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
  ...over,
});

const target = ex("barbell_curl", "Barbell Curl", "Barbell");
const dbCurl = ex("db_curl", "Dumbbell Curl", "Dumbbell");
const cableCurl = ex("cable_curl", "Cable Curl", "Machine/Cable", { level: "beginner" });
const machineCurl = ex("machine_curl", "Machine Curl", "Machine/Cable", { level: "expert" });
const bandCurl = ex("band_curl", "Band Curl", "Bands");
const ezCurl = ex("ez_curl", "EZ Bar Curl", "Barbell");
const squat = ex("squat", "Barbell Squat", "Barbell", { muscle_groups: ["Quads"] });
const ALL = [target, dbCurl, cableCurl, machineCurl, bandCurl, ezCurl, squat];

const opts = (over: Partial<Parameters<typeof replaceOptions>[3]> = {}) => ({ equipment: [], exclude: [], dislikedIds: [], limitations: [], ...over });
const ids = (r: { options: Exercise[] }) => r.options.map((e) => e.id);

describe("swap reasons", () => {
  it("the live workout sheet still offers its four reasons; the Coach adds two", () => {
    expect(SWAP_REASONS.map((r) => r.v)).toEqual(["busy", "equipment", "hurts", "variety"]);
    expect(ALL_SWAP_REASONS).toEqual(["busy", "equipment", "hurts", "variety", "difficult", "discomfort"]);
    expect(REPLACE_REASONS.map((r) => r.label)).toEqual(["Replace", "Equipment unavailable", "Too difficult", "Causes discomfort"]);
    for (const r of REPLACE_REASONS) expect(ALL_SWAP_REASONS).toContain(r.v);
  });

  it("too difficult prefers machines and cables, and ranks an expert-level exercise below the same one at an easier level", () => {
    const dbExpert = ex("db_expert", "Dumbbell Expert Curl", "Dumbbell", { level: "expert" });
    const order = swapOptions([...ALL, dbExpert], target, "difficult", 10).map((e) => e.id);
    expect(order[0]).toBe("cable_curl");
    expect(order.indexOf("db_curl")).toBeLessThan(order.indexOf("db_expert"));
    const plain = swapOptions([...ALL, dbExpert], target, "variety", 10).map((e) => e.id);
    expect(plain.indexOf("db_curl")).toBeLessThanOrEqual(plain.indexOf("db_expert"));
  });

  it("causes discomfort prefers machines and cables, like it hurts", () => {
    const a = swapOptions(ALL, target, "discomfort", 10).map((e) => e.id);
    const b = swapOptions(ALL, target, "hurts", 10).map((e) => e.id);
    expect(a).toEqual(b);
    expect(a.slice(0, 2).sort()).toEqual(["cable_curl", "machine_curl"]);
  });

  it("the existing reasons rank exactly as before", () => {
    expect(swapOptions(ALL, target, "busy", 10)[0].equipment).not.toBe("Barbell");
    expect(["Bodyweight", "Dumbbell", "Bands"]).toContain(swapOptions(ALL, target, "equipment", 10)[0].equipment);
  });
});

describe("replaceOptions", () => {
  it("offers only exercises for the same muscle, never the exercise itself", () => {
    const r = replaceOptions(ALL, target, "variety", opts());
    expect(ids(r)).not.toContain("barbell_curl");
    expect(ids(r)).not.toContain("squat");
    expect(r.options.length).toBeGreaterThan(0);
    expect(r.emptied).toBe(false);
  });

  it("leaves out ids already in the plan and ones the user never wants", () => {
    const r = replaceOptions(ALL, target, "variety", opts({ exclude: ["db_curl"], dislikedIds: ["cable_curl"] }));
    expect(ids(r)).not.toContain("db_curl");
    expect(ids(r)).not.toContain("cable_curl");
    expect(ids(r)).toContain("band_curl");
  });

  it("keeps to the user's equipment", () => {
    expect(replaceOptions(ALL, target, "variety", opts({ equipment: ["Dumbbell", "Bands"] })).options.map((e) => e.equipment).sort()).toEqual(["Bands", "Dumbbell"]);
  });

  it("equipment unavailable drops anything needing the same equipment, unless it is bodyweight", () => {
    expect(ids(replaceOptions(ALL, target, "equipment", opts()))).not.toContain("ez_curl");
    const bw = ex("push", "Push-Up", "Bodyweight");
    const bw2 = ex("dip", "Bar Dip", "Bodyweight");
    expect(ids(replaceOptions([bw, bw2], bw, "equipment", opts()))).toEqual(["dip"]);
  });

  it("limits always apply and are reported when they remove everything", () => {
    const lunge = ex("lunge", "Walking Lunge", "Bodyweight", { muscle_groups: ["Quads"] });
    const split = ex("split", "Bulgarian Split Squat", "Dumbbell", { muscle_groups: ["Quads"] });
    const press = ex("press", "Leg Press", "Machine/Cable", { muscle_groups: ["Quads"] });
    const some = replaceOptions([lunge, split, press, squat], squat, "variety", opts({ limitations: ["Knee"] }));
    expect(ids(some)).toEqual(["press"]);
    const none = replaceOptions([lunge, split, squat], squat, "variety", opts({ limitations: ["Knee"] }));
    expect(none).toEqual({ options: [], emptied: true });
  });

  it("is not emptied when there was nothing to offer in the first place", () => {
    expect(replaceOptions([target], target, "variety", opts({ limitations: ["Knee"] }))).toEqual({ options: [], emptied: false });
  });

  it("returns at most the limit, best first, and does not change its input", () => {
    const before = JSON.stringify(ALL);
    const r = replaceOptions(ALL, target, "variety", opts({ limit: 2 }));
    expect(r.options).toHaveLength(2);
    expect(r.options).toEqual(swapOptions(ALL, target, "variety", 10).slice(0, 2));
    expect(JSON.stringify(ALL)).toBe(before);
  });
});

describe("dislikeExercise", () => {
  const stored = async () => (await db.meta.get("goals"))?.value as Goals | undefined;
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it("adds an exercise once and keeps the other goals", async () => {
    await saveGoals({ sessionsPerWeek: 5 });
    await dislikeExercise("a");
    await dislikeExercise("a");
    await dislikeExercise("b");
    const s = await stored();
    expect(s?.dislikedIds).toEqual(["a", "b"]);
    expect(s?.sessionsPerWeek).toBe(5);
  });

  it("works on empty storage and removes again", async () => {
    await dislikeExercise("a");
    expect((await stored())?.dislikedIds).toEqual(["a"]);
    await undislikeExercise("a");
    expect((await stored())?.dislikedIds).toEqual([]);
    await undislikeExercise("never-there");
    expect((await stored())?.dislikedIds).toEqual([]);
  });

  it("keeps the newest MAX_DISLIKED", async () => {
    for (let i = 0; i < MAX_DISLIKED + 3; i++) await dislikeExercise(`e${i}`);
    const list = (await stored())!.dislikedIds;
    expect(list).toHaveLength(MAX_DISLIKED);
    expect(list[list.length - 1]).toBe(`e${MAX_DISLIKED + 2}`);
    expect(list).not.toContain("e0");
  });

  it("is read back by normalizeGoals", async () => {
    await dislikeExercise("x");
    expect(normalizeGoals(await stored()).dislikedIds).toEqual(["x"]);
    expect(DEFAULT_GOALS.dislikedIds).toEqual([]);
  });
});
