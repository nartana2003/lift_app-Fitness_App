import { describe, expect, it } from "vitest";
import { mentionedMuscles } from "../ask-coach";

// ask-coach's mentionedMuscles must keep its original, negation-blind
// behaviour: a coaching question about a muscle names that muscle even when the
// sentence has "not" or "skip" in it.
describe("ask-coach mentionedMuscles ignores negation", () => {
  it("Am I not training chest enough? -> Chest", () => {
    expect(mentionedMuscles("Am I not training chest enough?")).toEqual(["Chest"]);
  });

  it("Should I skip legs today? -> the leg muscles", () => {
    const ms = mentionedMuscles("Should I skip legs today?");
    expect(ms).toContain("Quads");
    expect(ms).toEqual(["Quads", "Hamstrings", "Glutes"]);
  });

  it("other negated coaching questions still name the muscle", () => {
    expect(mentionedMuscles("Why am I not hitting my legs enough")).toEqual(["Quads", "Hamstrings", "Glutes"]);
    expect(mentionedMuscles("I do not train arms enough, should I")).toEqual(["Biceps", "Triceps"]);
    expect(mentionedMuscles("no chest today?")).toEqual(["Chest"]);
  });
});
