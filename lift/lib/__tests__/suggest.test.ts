import { describe, expect, it } from "vitest";
import catalogue from "../../data/exercises.json";
import type { Exercise } from "../exercises";
import { suggestForMuscle } from "../suggest";

const all = catalogue as unknown as Exercise[];

describe("suggestForMuscle", () => {
  it("returns exercises for the right muscle", () => {
    for (const m of ["Chest", "Glutes", "Back", "Calves"]) {
      const picks = suggestForMuscle(all, m, 3);
      expect(picks).toHaveLength(3);
      expect(picks.every((p) => p.muscle_groups.includes(m as never))).toBe(true);
    }
  });

  it("prefers familiar gym lifts over obscure variations", () => {
    const names = suggestForMuscle(all, "Chest", 5).map((e) => e.name.toLowerCase());
    expect(names.some((n) => n.includes("bench press") || n.includes("push") || n.includes("fly") || n.includes("dip"))).toBe(true);
    expect(names.every((n) => n.split(" ").length <= 6)).toBe(true);
  });

  it("returns nothing for an unknown muscle", () => {
    expect(suggestForMuscle(all, "Tail", 3)).toEqual([]);
  });
});
