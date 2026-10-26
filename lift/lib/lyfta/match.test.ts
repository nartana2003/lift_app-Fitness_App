import { describe, expect, it } from "vitest";
import catalogue from "../../data/exercises.json";
import { matchExercise, tokens } from "./match";
import type { Exercise } from "../exercises";

const ex = catalogue as unknown as Exercise[];
const best = (n: string) => matchExercise(n, ex);

describe("tokens", () => {
  it("normalises plurals, synonyms and joined words", () => {
    expect(tokens("Leg Extensions")).toEqual(["leg", "extension"]);
    expect(tokens("Pull-up")).toEqual(tokens("Pullups"));
    expect(tokens("Lever Chest Press")).toEqual(tokens("Leverage Chest Press"));
    expect(tokens("Machine Flyes")).toEqual(["lever", "fly"]);
    expect(tokens("Smith Machine Squat")).toEqual(["smith", "squat"]);
    expect(tokens("Hanging Leg Raises For Abs")).toEqual(tokens("Hanging Leg Raise"));
  });
});

// Real exercise names from a Lyfta account → what our catalogue calls them.
const SAFE: [string, string][] = [
  ["Triceps Pushdown", "Triceps Pushdown"],
  ["Hammer Curl", "Hammer Curls"],
  ["Pull-up", "Pullups"],
  ["Dumbbell Bench Press", "Dumbbell Bench Press"],
  ["Lever Chest Press", "Leverage Chest Press"],
  ["Hanging Leg Raises For Abs", "Hanging Leg Raise"],
  ["Spider Curls", "Spider Curl"],
  ["Lever Hip Thrust", "Lever Hip Thrust"],
  ["Lever Seated Hip Abduction", "Thigh Abductor"],
  ["Lever Seated Hip Adduction", "Thigh Adductor"],
  ["Hip Thrust", "Barbell Hip Thrust"],
  ["Barbell Bench Press", "Barbell Bench Press - Medium Grip"],
  ["Bench Press", "Barbell Bench Press - Medium Grip"],
  ["Incline Bench Press", "Barbell Incline Bench Press - Medium Grip"],
  ["Lateral Raise", "Side Lateral Raise"],
  ["Lever Seated Fly", "Butterfly"],
  ["Lever Seated Reverse Fly", "Reverse Machine Flyes"],
  ["Cable Standing Fly", "Cable Crossover"],
  ["Cable Pushdown", "Triceps Pushdown"],
  ["Dumbbell Incline Bench Press", "Incline Dumbbell Press"],
];

const BEST_GUESS_NEEDS_REVIEW: [string, string][] = [
  ["Lever Leg Extension", "Leg Extensions"],
  ["Lever Seated Leg Curl", "Seated Leg Curl"],
  ["Lever Lying Leg Curl", "Lying Leg Curls"],
  ["Lever Seated Shoulder Press", "Leverage Shoulder Press"],
  ["Lever Seated Leg Press", "Leg Press"],
  ["Full Squat", "Barbell Full Squat"],
  ["Cable Kneeling Crunch", "Cable Crunch"],
  ["Straight Back Seated Row", "Seated Cable Rows"],
  ["Zottomon Curls", "Zottman Curl"], // typo
  ["Band face pull", "Face Pull"],
  ["Seated Shoulder Press", "Seated Cable Shoulder Press"],
];

describe("matching real Lyfta names", () => {
  it.each(SAFE)("%s → %s without asking", (lyfta, ours) => {
    const r = best(lyfta);
    expect(["exact", "auto"]).toContain(r.confidence);
    expect(r.best?.name).toBe(ours);
  });

  it.each(BEST_GUESS_NEEDS_REVIEW)("%s: first suggestion is %s", (lyfta, ours) => {
    const r = best(lyfta);
    expect(r.best?.name).toBe(ours);
  });

  it("never marks a doubtful guess as safe", () => {
    for (const n of ["Lever Squat", "Bar Lateral Pulldown"]) {
      expect(["exact", "auto"]).not.toContain(best(n).confidence);
    }
  });

  it("doesn't pre-select a different exercise when most of the name is unexplained", () => {
    for (const n of ["African Curls", "Bayesian Cable Curls", "Seated Side-to-Side Leg Raise Crunch on Floor", "Zzxq Flurbo Machine"]) {
      const r = best(n);
      expect(r.confidence).toBe("none");
      expect(r.best).toBeUndefined();
    }
  });

  it("ignores (male)/(female) style notes", () => {
    expect(tokens("Hanging Hollow Hold (female)")).toEqual(tokens("Hanging Hollow Hold"));
  });

  it("returns no match for gibberish", () => {
    expect(best("Zzxq Flurbo Machine").confidence).toBe("none");
  });
});
