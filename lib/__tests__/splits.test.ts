import { describe, expect, it } from "vitest";
import { PRESETS, splitGaps } from "../splits";
import { MUSCLE_GROUPS } from "../muscles";

describe("split presets", () => {
  it("every preset has named days with real muscle groups", () => {
    for (const p of PRESETS) {
      expect(p.days.length).toBeGreaterThan(1);
      for (const d of p.days) {
        expect(d.name).toBeTruthy();
        expect(d.muscles.length).toBeGreaterThan(0);
        for (const m of d.muscles) expect(MUSCLE_GROUPS).toContain(m);
      }
    }
  });

  it("Push/Pull/Legs covers the big muscles", () => {
    const ppl = PRESETS[0];
    const covered = ppl.days.flatMap((d) => d.muscles);
    for (const m of ["Chest", "Back", "Quads", "Glutes", "Shoulders"]) expect(covered).toContain(m);
  });
});

describe("splitGaps", () => {
  it("lists muscles no day covers", () => {
    const gaps = splitGaps({ name: "x", days: [{ name: "Push", muscles: ["Chest"] }] }, MUSCLE_GROUPS);
    expect(gaps.missing).toContain("Glutes");
    expect(gaps.missing).not.toContain("Chest");
  });

  it("flags days with no muscles", () => {
    const gaps = splitGaps({ name: "x", days: [{ name: "Empty", muscles: [] }] }, MUSCLE_GROUPS);
    expect(gaps.emptyDays).toEqual(["Empty"]);
  });
});
