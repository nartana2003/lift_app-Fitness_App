import { describe, expect, it } from "vitest";
import { allTargets, defaultTarget, DEFAULT_GOALS, type Goals } from "../goals";
import { MUSCLE_GROUPS } from "../muscles";
import { goalProgress } from "../stats";

const g = (p: Partial<Goals> = {}): Goals => ({ ...DEFAULT_GOALS, ...p });

describe("default weekly targets", () => {
  it("gives focus muscles more sets", () => {
    const base = defaultTarget("Chest", g());
    const focused = defaultTarget("Chest", g({ focusMuscles: ["Chest"] }));
    expect(focused).toBe(base + 4);
  });

  it("scales with experience", () => {
    expect(defaultTarget("Chest", g({ experience: "beginner" }))).toBeLessThan(defaultTarget("Chest", g()));
    expect(defaultTarget("Chest", g({ experience: "advanced" }))).toBeGreaterThan(defaultTarget("Chest", g()));
  });

  it("asks less of small muscles and of fat-loss plans", () => {
    expect(defaultTarget("Calves", g())).toBeLessThan(defaultTarget("Chest", g()));
    expect(defaultTarget("Chest", g({ goalType: "fat_loss" }))).toBeLessThan(defaultTarget("Chest", g()));
  });

  it("stays within sane bounds for every muscle and setting", () => {
    for (const m of MUSCLE_GROUPS)
      for (const experience of ["beginner", "intermediate", "advanced"] as const)
        for (const sessions of [1, 3, 6]) {
          const n = defaultTarget(m, g({ experience, sessionsPerWeek: sessions }));
          expect(n).toBeGreaterThanOrEqual(4);
          expect(n).toBeLessThanOrEqual(24);
        }
  });

  it("uses the user's own number when they set one", () => {
    const t = allTargets(g({ targets: { Glutes: 20 } }));
    expect(t.Glutes).toBe(20);
    expect(t.Chest).toBe(defaultTarget("Chest", g()));
    expect(Object.keys(t)).toHaveLength(MUSCLE_GROUPS.length);
  });
});

describe("weekly progress against targets", () => {
  it("reports done, remaining and status per muscle", () => {
    const targets = allTargets(g({ focusMuscles: ["Glutes"] }));
    const rows = goalProgress({ Glutes: 4, Chest: 99 }, targets);
    const glutes = rows.find((r) => r.muscle === "Glutes")!;
    expect(glutes.done).toBe(4);
    expect(glutes.remaining).toBe(glutes.target - 4);
    expect(glutes.status).toBe("partial");
    expect(rows.find((r) => r.muscle === "Chest")!.status).toBe("met");
    expect(rows.find((r) => r.muscle === "Calves")!.status).toBe("none");
  });
});
