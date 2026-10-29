import { describe, expect, it } from "vitest";
import { allowedFor, filterByLimitations, isLimitation, LIMITATIONS } from "../limitations";

const ex = (name: string, original_name?: string) => ({ name, original_name });

describe("allowedFor", () => {
  it("allows everything with no limits", () => {
    expect(allowedFor(ex("Barbell Deadlift"), [])).toBe(true);
  });

  it("removes movements that load the chosen area", () => {
    expect(allowedFor(ex("Standing Military Press"), ["Shoulder"])).toBe(false);
    expect(allowedFor(ex("Walking Lunge"), ["Knee"])).toBe(false);
    expect(allowedFor(ex("Barbell Deadlift"), ["Lower back"])).toBe(false);
    expect(allowedFor(ex("Wrist Curl"), ["Wrist"])).toBe(false);
    expect(allowedFor(ex("Lying Triceps Skull Crusher"), ["Elbow"])).toBe(false);
    expect(allowedFor(ex("Sumo Squat"), ["Hip"])).toBe(false);
  });

  it("keeps exercises that do not load the area", () => {
    expect(allowedFor(ex("Lat Pulldown"), ["Shoulder", "Knee", "Wrist"])).toBe(true);
    expect(allowedFor(ex("Incline Dumbbell Curl"), ["Knee", "Lower back"])).toBe(true);
    expect(allowedFor(ex("Standing Military Press"), ["Knee"])).toBe(true);
  });

  it("checks the catalogue name of a renamed exercise too", () => {
    expect(allowedFor(ex("My lunge day", "Walking Lunge"), ["Knee"])).toBe(false);
  });

  it("any one chosen limit is enough to remove it", () => {
    expect(allowedFor(ex("Barbell Deadlift"), ["Wrist", "Lower back"])).toBe(false);
  });
});

describe("filterByLimitations", () => {
  const list = [ex("Walking Lunge"), ex("Leg Press"), ex("Hack Squat")];

  it("splits into allowed and removed in order", () => {
    const f = filterByLimitations(list, ["Knee"]);
    expect(f.allowed.map((e) => e.name)).toEqual(["Leg Press"]);
    expect(f.removed.map((e) => e.name)).toEqual(["Walking Lunge", "Hack Squat"]);
    expect(f.emptied).toBe(false);
  });

  it("flags a list the limits emptied, never a list that was already empty", () => {
    expect(filterByLimitations([ex("Walking Lunge")], ["Knee"]).emptied).toBe(true);
    expect(filterByLimitations([], ["Knee"]).emptied).toBe(false);
  });
});

describe("isLimitation", () => {
  it("accepts the preset chips only", () => {
    for (const l of LIMITATIONS) expect(isLimitation(l)).toBe(true);
    expect(isLimitation("Neck")).toBe(false);
    expect(isLimitation(3)).toBe(false);
  });
});
