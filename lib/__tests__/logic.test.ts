import { describe, expect, it } from "vitest";
import { compare, daysLeftInWeek, delta, goalProgress, startOfWeek } from "../stats";
import { applySet, bestsFromHistory, e1rm, emptyBests, isVolumePr, setPrs } from "../prs";
import { formatSets, parseRepRange, suggest } from "../overload";
import { mapEquipment, mapMuscles, tiktokUrl } from "../muscles";

describe("stats", () => {
  it("computes deltas incl. divide-by-zero", () => {
    expect(delta(4, 2)).toEqual({ current: 4, previous: 2, diff: 2, pct: 100 });
    expect(delta(3, 0).pct).toBeNull();
    expect(delta(0, 0).pct).toBe(0);
    expect(delta(1, 2).pct).toBe(-50);
  });

  it("compares periods", () => {
    const c = compare(
      { sessions: 3, duration_sec: 9000, volume: 12000, sets_by_muscle: { Chest: 10, Glutes: 4 }, workout_days: [] },
      { sessions: 2, duration_sec: 6000, volume: 15000, sets_by_muscle: {}, workout_days: [] },
    );
    expect(c.sessions.diff).toBe(1);
    expect(c.volume.pct).toBe(-20);
    expect(c.musclesHit).toBe(2);
  });

  it("weeks start on Monday", () => {
    const sun = new Date(2026, 9, 18); // Sun 18 Oct 2026
    expect(startOfWeek(sun).getDate()).toBe(12);
    expect(daysLeftInWeek(new Date(2026, 9, 12))).toBe(7); // Mon
    expect(daysLeftInWeek(sun)).toBe(1);
  });

  it("goal progress: remaining sets and status", () => {
    const g = goalProgress({ Glutes: 4, Chest: 14 }, { Glutes: 14, Chest: 12, Calves: 6 });
    expect(g[0]).toEqual({ muscle: "Glutes", done: 4, target: 14, remaining: 10, status: "partial" });
    expect(g.find((x) => x.muscle === "Chest")?.status).toBe("met");
    expect(g.find((x) => x.muscle === "Calves")?.status).toBe("none");
  });
});

describe("PRs", () => {
  it("Epley 1RM", () => {
    expect(e1rm(100, 1)).toBe(100);
    expect(e1rm(60, 10)).toBe(80);
    expect(e1rm(0, 5)).toBe(0);
  });

  it("detects weight, reps and e1rm PRs; ignores warmups", () => {
    const b = bestsFromHistory([[{ reps: 10, weight: 60 }, { reps: 8, weight: 60 }, { reps: 15, weight: 100, is_warmup: true }]]);
    expect(b.weight).toBe(60);
    expect(setPrs({ reps: 11, weight: 60 }, b)).toEqual(["reps", "e1rm"]);
    expect(setPrs({ reps: 5, weight: 62.5 }, b)).toEqual(["weight"]);
    expect(setPrs({ reps: 9, weight: 60 }, b)).toEqual([]);
    expect(setPrs({ reps: 20, weight: 100, is_warmup: true }, b)).toEqual([]);
  });

  it("first-ever set isn't a reps PR at an unseen weight, but is a weight PR", () => {
    expect(setPrs({ reps: 5, weight: 40 }, emptyBests())).toEqual(["weight", "e1rm"]);
  });

  it("applySet accumulates so the same set twice isn't a PR twice", () => {
    let b = bestsFromHistory([[{ reps: 10, weight: 60 }]]);
    expect(setPrs({ reps: 5, weight: 70 }, b)).toContain("weight");
    b = applySet(b, { reps: 5, weight: 70 });
    expect(setPrs({ reps: 5, weight: 70 }, b)).toEqual([]);
  });

  it("volume PR", () => {
    const b = bestsFromHistory([[{ reps: 10, weight: 60 }, { reps: 10, weight: 60 }]]);
    expect(isVolumePr([{ reps: 10, weight: 60 }, { reps: 10, weight: 60 }, { reps: 1, weight: 60 }], b)).toBe(true);
    expect(isVolumePr([{ reps: 10, weight: 60 }], b)).toBe(false);
  });
});

describe("overload suggestions", () => {
  const range = { min: 8, max: 10 };

  it("adds weight when top of range hit", () => {
    const s = suggest([{ reps: 10, weight: 60 }, { reps: 10, weight: 60 }, { reps: 10, weight: 60 }], range, "Barbell");
    expect(s).toMatchObject({ sets: 3, reps: 8, weight: 62.5 });
  });

  it("bigger jump when all sets were easy (RIR 3)", () => {
    const easy = suggest([{ reps: 10, weight: 60, rir: 3 }, { reps: 10, weight: 60, rir: 3 }], range, "Barbell");
    const hard = suggest([{ reps: 10, weight: 60, rir: 1 }, { reps: 10, weight: 60, rir: 1 }], range, "Barbell");
    expect(easy!.weight).toBe(65);
    expect(hard!.weight).toBe(62.5);
  });

  it("drops ~5% after failure with missed reps", () => {
    const s = suggest([{ reps: 8, weight: 100, rir: 0 }, { reps: 6, weight: 100, rir: 0 }], range, "Barbell");
    expect(s).toMatchObject({ weight: 95, reps: 8 });
  });

  it("holds weight when reps missed without failure data", () => {
    expect(suggest([{ reps: 6, weight: 50 }], range, "Dumbbell")).toMatchObject({ weight: 50, reps: 8 });
  });

  it("adds a rep inside the range", () => {
    expect(suggest([{ reps: 8, weight: 50 }, { reps: 9, weight: 50 }], range, "Dumbbell")).toMatchObject({ weight: 50, reps: 9 });
  });

  it("bodyweight progresses reps", () => {
    expect(suggest([{ reps: 10, weight: 0 }], range, "Bodyweight")).toMatchObject({ reps: 11, weight: 0 });
  });

  it("ignores warmups and handles empty", () => {
    expect(suggest([{ reps: 10, weight: 20, is_warmup: true }], range, "Barbell")).toBeNull();
  });

  it("parses rep ranges and formats sets", () => {
    expect(parseRepRange("8-12")).toEqual({ min: 8, max: 12 });
    expect(parseRepRange("10")).toEqual({ min: 10, max: 10 });
    expect(parseRepRange("45s")).toEqual({ min: 45, max: 45 });
    expect(formatSets([{ reps: 10, weight: 60 }, { reps: 10, weight: 60 }, { reps: 10, weight: 60 }])).toBe("3×10 @ 60kg");
    expect(formatSets([{ reps: 10, weight: 60 }, { reps: 8, weight: 60 }])).toBe("10/8 @ 60kg");
  });
});

describe("muscle + equipment mapping", () => {
  it("maps dataset muscles to app groups", () => {
    expect(mapMuscles(["quadriceps", "abductors", "adductors", "unknown"])).toEqual(["Quads", "Hips/Adductors/Abductors"]);
    expect(mapEquipment("cable")).toBe("Machine/Cable");
    expect(mapEquipment(null)).toBe("Bodyweight");
    expect(mapEquipment("e-z curl bar")).toBe("Barbell");
    expect(tiktokUrl("Barbell Squat")).toBe("https://www.tiktok.com/search?q=Barbell%20Squat%20exercise%20form");
  });
});

import { dispNum, fmtVolume, fmtWeight, fromDisplay, toDisplay } from "../units";

describe("units + week start", () => {
  it("converts kg <-> lb and round-trips", () => {
    expect(dispNum(100, "lb")).toBe(220.5);
    expect(dispNum(62.5, "kg")).toBe(62.5);
    expect(fromDisplay(toDisplay(60, "lb"), "lb")).toBeCloseTo(60, 9);
    expect(fmtWeight(60, "kg")).toBe("60kg");
    expect(fmtVolume(1000, "lb")).toBe("2,205lb");
  });

  it("week can start on Sunday", () => {
    const wed = new Date(2026, 9, 14); // Wed 14 Oct 2026
    expect(startOfWeek(wed, 1).getDate()).toBe(12); // Mon
    expect(startOfWeek(wed, 0).getDate()).toBe(11); // Sun
    expect(daysLeftInWeek(new Date(2026, 9, 11), 0)).toBe(7); // Sun with Sunday start
    expect(daysLeftInWeek(new Date(2026, 9, 17), 0)).toBe(1); // Sat with Sunday start
  });
});

import { applyRenames, searchExercises, type Exercise } from "../exercises";

describe("renaming exercises", () => {
  const base = { muscle_groups: ["Chest"], secondary_groups: [], equipment: "Barbell", category: "strength", mechanic: null, force: null, level: "beginner", instructions: [], image_urls: [], tiktok_url: "" } as const;
  const list = [
    { ...base, id: "a", name: "Barbell Bench Press - Medium Grip" },
    { ...base, id: "b", name: "Pullups" },
  ] as unknown as Exercise[];

  it("applies custom names and keeps the original", () => {
    const r = applyRenames(list, { a: "Bench Press" });
    expect(r[0]).toMatchObject({ name: "Bench Press", original_name: "Barbell Bench Press - Medium Grip" });
    expect(r[1]).toBe(list[1]); // untouched
    expect(applyRenames(list, {})).toEqual(list);
    expect(applyRenames(list, { a: "  " })[0].name).toBe("Barbell Bench Press - Medium Grip");
  });

  it("search finds a renamed exercise by either name", () => {
    const r = applyRenames(list, { a: "My Chest Day Lift" });
    expect(searchExercises(r, { q: "chest day" }).map((e) => e.id)).toEqual(["a"]);
    expect(searchExercises(r, { q: "medium grip" }).map((e) => e.id)).toEqual(["a"]);
    expect(searchExercises(r, { q: "pullups" }).map((e) => e.id)).toEqual(["b"]);
  });
});
