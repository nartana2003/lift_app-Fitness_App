import { describe, expect, it } from "vitest";
import { DEFAULT_PER_MUSCLE, lastDoneLabel, normalizePerMuscle } from "../TodayPicks";

describe("normalizePerMuscle (QA)", () => {
  it("accepts 1..3 only", () => {
    for (const n of [1, 2, 3]) expect(normalizePerMuscle(n)).toBe(n);
  });
  it.each([0, 4, -1, 1.5, NaN, Infinity, "2", null, undefined, {}, [], 1e9])("falls back for %s", (v) => {
    expect(normalizePerMuscle(v)).toBe(DEFAULT_PER_MUSCLE);
  });
});

describe("lastDoneLabel (QA)", () => {
  it("handles null, today, singular, plural, negative and huge", () => {
    expect(lastDoneLabel(null)).toBe("not done yet");
    expect(lastDoneLabel(0)).toBe("last done today");
    expect(lastDoneLabel(-3)).toBe("last done today");
    expect(lastDoneLabel(1)).toBe("last done 1 day ago");
    expect(lastDoneLabel(2)).toBe("last done 2 days ago");
    expect(lastDoneLabel(100000)).toBe("last done 100000 days ago");
  });
});
