import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../offline/db";
import {
  allTargets,
  defaultTarget,
  DEFAULT_GOALS,
  goalsChanged,
  goalsFingerprint,
  mergeGoals,
  normalizeGoals,
  saveGoals,
  setTarget,
  type Goals,
} from "../goals";
import { MUSCLE_GROUPS } from "../muscles";
import { saveSplit } from "../splits";

const g = (p: Partial<Goals> = {}): Goals => normalizeGoals({ ...DEFAULT_GOALS, ...p });
const stored = async () => (await db.meta.get("goals"))?.value as Goals | undefined;

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("normalizeGoals (older saved goals)", () => {
  it("turns focus muscles into high priorities and the note into the first ranked goal", () => {
    const n = normalizeGoals({ focusMuscles: ["Biceps", "Abs/Core"], note: "  grow my arms " });
    expect(n.priorities).toEqual({ Biceps: "high", "Abs/Core": "high" });
    expect(n.rankedGoals).toEqual(["grow my arms"]);
    expect(n.limitations).toEqual([]);
    expect(n.dislikedIds).toEqual([]);
  });

  it("gives empty Coach fields to goals stored with none of them", () => {
    const n = normalizeGoals(undefined);
    expect(n).toEqual(DEFAULT_GOALS);
  });

  it("keeps priorities that are already set", () => {
    const n = normalizeGoals({ priorities: { Glutes: "medium" }, focusMuscles: ["Chest"] });
    expect(n.priorities).toEqual({ Glutes: "medium" });
  });
});

describe("default targets with priorities", () => {
  it("gives focus-only goals exactly the same targets as before priorities existed", () => {
    for (const m of MUSCLE_GROUPS) {
      const legacy = { ...DEFAULT_GOALS, focusMuscles: ["Chest", "Biceps"] as Goals["focusMuscles"] };
      expect(defaultTarget(m, normalizeGoals(legacy))).toBe(defaultTarget(m, legacy));
    }
    expect(defaultTarget("Chest", g({ focusMuscles: ["Chest"] }))).toBe(defaultTarget("Chest", g()) + 4);
  });

  it("high +4, medium +2, low -2", () => {
    const base = defaultTarget("Chest", g());
    expect(defaultTarget("Chest", g({ priorities: { Chest: "high" } }))).toBe(base + 4);
    expect(defaultTarget("Chest", g({ priorities: { Chest: "medium" } }))).toBe(base + 2);
    expect(defaultTarget("Chest", g({ priorities: { Chest: "low" } }))).toBe(base - 2);
  });

  it("does not change muscles with no priority and keeps the 4 to 24 bounds", () => {
    const t = allTargets(g({ priorities: { Chest: "high" } }));
    expect(t.Back).toBe(defaultTarget("Back", g()));
    for (const m of MUSCLE_GROUPS) {
      expect(t[m]).toBeGreaterThanOrEqual(4);
      expect(t[m]).toBeLessThanOrEqual(24);
    }
  });
});

describe("mergeGoals keeps linked fields equal", () => {
  it("rewrites focusMuscles from the high priorities", () => {
    const next = mergeGoals(g({ focusMuscles: ["Chest"] }), { priorities: { Biceps: "high", Back: "medium" } });
    expect(next.focusMuscles).toEqual(["Biceps"]);
    expect(next.priorities).toEqual({ Biceps: "high", Back: "medium" });
  });

  it("a focus toggle updates priorities and leaves medium and low alone", () => {
    const cur = g({ priorities: { Chest: "high", Back: "medium", Calves: "low" } });
    const next = mergeGoals(cur, { focusMuscles: ["Biceps"] });
    expect(next.priorities).toEqual({ Biceps: "high", Back: "medium", Calves: "low" });
    expect(next.focusMuscles).toEqual(["Biceps"]);
  });

  it("rankedGoals sets note to the first goal, trims, drops blanks and caps at 3", () => {
    const next = mergeGoals(g(), { rankedGoals: [" Bigger arms ", "", "Abs", "Lats", "Glutes"] });
    expect(next.rankedGoals).toEqual(["Bigger arms", "Abs", "Lats"]);
    expect(next.note).toBe("Bigger arms");
  });

  it("a note-only patch (the old wizard) replaces ranked goal 1 and keeps the rest", () => {
    const cur = g({ rankedGoals: ["old", "Abs"], note: "old" });
    expect(mergeGoals(cur, { note: "new" }).rankedGoals).toEqual(["new", "Abs"]);
    expect(mergeGoals(cur, { note: "" }).rankedGoals).toEqual(["Abs"]);
  });
});

describe("saveGoals and setTarget (Dexie)", () => {
  it("stores the merged goals and keeps both views in step", async () => {
    await saveGoals({ priorities: { Lats: "high" }, rankedGoals: ["Build my back"], limitations: ["Knee"] });
    const s = await stored();
    expect(s?.focusMuscles).toEqual(["Lats"]);
    expect(s?.note).toBe("Build my back");
    expect(s?.limitations).toEqual(["Knee"]);
  });

  it("old callers still work: a focus toggle on empty storage", async () => {
    await saveGoals({ focusMuscles: ["Chest"] });
    const s = await stored();
    expect(s?.priorities).toEqual({ Chest: "high" });
    expect(s?.sessionsPerWeek).toBe(3);
  });

  it("setTarget keeps the Coach fields", async () => {
    await saveGoals({ priorities: { Chest: "medium" } });
    await setTarget("Glutes", 18);
    const s = await stored();
    expect(s?.targets).toEqual({ Glutes: 18 });
    expect(s?.priorities).toEqual({ Chest: "medium" });
  });
});

describe("goalsFingerprint and goalsChanged", () => {
  const day = { name: "Day 1", muscles: [] as never[] };

  it("is the same for the same wants and for a migrated focus-only goal", () => {
    expect(goalsFingerprint(g({ priorities: { Chest: "high" } }))).toBe(goalsFingerprint({ focusMuscles: ["Chest"] }));
  });

  it("changes when priorities, typed goals, days or limits change", () => {
    const base = goalsFingerprint(g());
    expect(goalsFingerprint(g({ priorities: { Glutes: "high" } }))).not.toBe(base);
    expect(goalsFingerprint(g({ rankedGoals: ["abs"] }))).not.toBe(base);
    expect(goalsFingerprint(g({ sessionsPerWeek: 5 }))).not.toBe(base);
    expect(goalsFingerprint(g({ limitations: ["Wrist"] }))).not.toBe(base);
  });

  it("ignores set-target edits and dislikes", () => {
    const base = goalsFingerprint(g());
    expect(goalsFingerprint(g({ targets: { Chest: 20 }, dislikedIds: ["x"] }))).toBe(base);
  });

  it("flags only a split built for different goals", () => {
    const goals = g({ priorities: { Biceps: "high" } });
    const builtFor = goalsFingerprint(goals);
    expect(goalsChanged(goals, { days: [day], builtFor })).toBe(false);
    expect(goalsChanged(g({ priorities: { Glutes: "high" } }), { days: [day], builtFor })).toBe(true);
  });

  it("never flags a split with no builtFor or no days", () => {
    const goals = g({ priorities: { Biceps: "high" } });
    expect(goalsChanged(goals, { days: [day] })).toBe(false);
    expect(goalsChanged(goals, { days: [], builtFor: "old" })).toBe(false);
  });

  it("builtFor survives saveSplit", async () => {
    await saveSplit({ name: "S", days: [{ name: "A", muscles: ["Chest"] }], builtFor: "fp" });
    const s = (await db.meta.get("split"))?.value as { builtFor?: string; days: { id?: string }[] };
    expect(s.builtFor).toBe("fp");
    expect(s.days[0].id).toBeTruthy();
  });
});
