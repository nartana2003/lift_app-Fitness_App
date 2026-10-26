import { describe, expect, it } from "vitest";
import { reviewDefaultTarget, reviewSetup, type ReviewGoals, type ReviewInput, type ReviewPool } from "../coachReview";
import type { Exercise } from "../exercises";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "../muscles";
import type { Split } from "../splits";

const EQUIP: Equipment[] = ["Machine/Cable", "Dumbbell", "Barbell", "Bodyweight", "Bands", "Kettlebell", "Other"];

const ex = (id: string, name: string, muscles: MuscleGroup[], p: Partial<Exercise> = {}): Exercise => ({
  id,
  name,
  muscle_groups: muscles,
  secondary_groups: [],
  equipment: "Dumbbell",
  category: "strength",
  mechanic: "isolation",
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
  ...p,
});

// Fixed-seed PRNG so the fuzz cases are reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["Curl", "Press", "Row", "Squat", "Raise", "Fly", "Extension", "Crunch", "Thrust", "Pulldown", "Lunge", "Shrug"];
const ADJ = ["Incline", "Hammer", "Seated", "Standing", "Reverse", "Cable", "Barbell", "Single-Leg", "Wide-Grip", "Front", ""];

function makeCatalogue(n: number, rand: () => number): Exercise[] {
  const out: Exercise[] = [];
  for (let i = 0; i < n; i++) {
    const m1 = MUSCLE_GROUPS[Math.floor(rand() * MUSCLE_GROUPS.length)];
    const m2 = MUSCLE_GROUPS[Math.floor(rand() * MUSCLE_GROUPS.length)];
    out.push(
      ex(`c${i}`, `${ADJ[Math.floor(rand() * ADJ.length)]} ${WORDS[Math.floor(rand() * WORDS.length)]} ${i}`.trim(), [...new Set([m1, m2])], {
        equipment: EQUIP[Math.floor(rand() * EQUIP.length)],
        mechanic: rand() < 0.4 ? "compound" : "isolation",
      }),
    );
  }
  return out;
}

const goals = (p: Partial<ReviewGoals> = {}): ReviewGoals => ({
  goalType: "build_muscle",
  experience: "intermediate",
  sessionsPerWeek: 3,
  focusMuscles: [],
  targets: {},
  ...p,
});

const SPLIT: Split = {
  name: "s",
  days: [
    { name: "A", muscles: ["Chest", "Biceps"] },
    { name: "B", muscles: ["Back", "Triceps"] },
    { name: "C", muscles: ["Quads", "Glutes"] },
  ],
};

const CAT = [
  ex("bench", "Bench Press", ["Chest"], { equipment: "Barbell", mechanic: "compound" }),
  ex("fly", "Dumbbell Fly", ["Chest"]),
  ex("pec", "Pec Deck", ["Chest"], { equipment: "Machine/Cable" }),
  ex("curl", "Dumbbell Curl", ["Biceps"]),
  ex("hcurl", "Hammer Curl", ["Biceps"]),
  ex("row", "Barbell Row", ["Back"], { equipment: "Barbell", mechanic: "compound" }),
  ex("push", "Triceps Pushdown", ["Triceps"], { equipment: "Machine/Cable" }),
  ex("squat", "Barbell Squat", ["Quads", "Glutes"], { equipment: "Barbell", mechanic: "compound" }),
  ex("thrust", "Barbell Hip Thrust", ["Glutes"], { equipment: "Barbell", mechanic: "compound" }),
];

const base = (p: Partial<ReviewInput> = {}): ReviewInput => ({
  goals: goals(),
  split: SPLIT,
  pool: {},
  catalogue: CAT,
  equipment: [],
  ...p,
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

function checkInvariants(inp: ReviewInput) {
  const r = reviewSetup(inp);
  const known = new Map(inp.catalogue.map((e) => [e.id, e]));
  const inPool = new Set<string>();
  for (const list of Object.values(inp.pool)) for (const x of list ?? []) inPool.add(typeof x === "string" ? x : x.id);
  const seen = new Set<string>();
  const flagged = new Set(r.findings.map((f) => f.muscle).filter(Boolean));
  for (const s of r.suggestions) {
    expect(known.has(s.exercise_id)).toBe(true);
    expect(inPool.has(s.exercise_id)).toBe(false);
    expect(seen.has(s.exercise_id)).toBe(false);
    seen.add(s.exercise_id);
    expect(s.exercise.muscle_groups).toContain(s.muscle);
    expect(flagged.has(s.muscle)).toBe(true);
    if (inp.equipment.length) expect(inp.equipment).toContain(s.exercise.equipment);
    expect(s.reason).toBeTruthy();
  }
  for (const m of MUSCLE_GROUPS) expect(r.suggestions.filter((s) => s.muscle === m).length).toBeLessThanOrEqual(3);
  for (const f of r.findings) {
    expect(f.message).not.toMatch(/undefined|NaN|\[object|null/);
    expect(["info", "warn"]).toContain(f.severity);
  }
  for (const l of r.load) {
    expect(Number.isFinite(l.weeklySets)).toBe(true);
    expect(l.weeklySets).toBeGreaterThanOrEqual(0);
    expect(l.splitDays).toBeGreaterThan(0);
  }
  // Load rows are in MUSCLE_GROUPS order.
  const idx = r.load.map((l) => MUSCLE_GROUPS.indexOf(l.muscle));
  expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  return r;
}

describe("coachReview QA: hostile and degenerate input", () => {
  it("does not mutate frozen inputs", () => {
    const inp = deepFreeze(
      base({ pool: { Chest: ["bench"] }, goals: goals({ focusMuscles: ["Chest"], targets: { Back: 10 } }), equipment: ["Barbell"] }),
    );
    expect(() => reviewSetup(inp)).not.toThrow();
  });

  it("survives null and malformed split days and muscle lists", () => {
    const split = { name: "x", days: [null, { name: 5, muscles: null }, { muscles: ["Chest", "Nope", "Chest", 7] }, undefined] } as unknown as Split;
    const r = reviewSetup(base({ split }));
    expect(r.load.map((l) => l.muscle)).toEqual(["Chest"]);
    expect(r.load[0].splitDays).toBe(1);
  });

  it("survives a missing split days array and missing pool", () => {
    expect(() => reviewSetup(base({ split: { name: "x" } as unknown as Split }))).not.toThrow();
    expect(() => reviewSetup(base({ pool: undefined as unknown as ReviewPool }))).not.toThrow();
    expect(reviewSetup(base({ split: { name: "x" } as unknown as Split })).findings.map((f) => f.code)).toEqual(["no_split"]);
  });

  it("treats pool entries that are null, numbers or unknown ids as absent", () => {
    const pool = { Chest: [null, 5, "ghost", "bench", "bench", undefined] } as unknown as ReviewPool;
    const r = reviewSetup(base({ pool }));
    expect(r.load.find((l) => l.muscle === "Chest")?.poolSize).toBe(1);
    expect(r.findings.some((f) => f.muscle === "Chest" && f.code === "one_exercise")).toBe(true);
  });

  it("ignores pool keys that are not muscles (including __proto__)", () => {
    const pool = JSON.parse('{"__proto__": ["bench"], "Nope": ["fly"], "constructor": ["pec"]}') as ReviewPool;
    const r = reviewSetup(base({ pool }));
    expect(r.load.find((l) => l.muscle === "Chest")?.poolSize).toBe(0);
    expect(Object.prototype.hasOwnProperty.call({}, "bench")).toBe(false);
  });

  it("clamps odd sessionsPerWeek values (NaN, 0, negative, fractional, huge, Infinity)", () => {
    for (const s of [NaN, 0, -4, 2.9, 99, Infinity, -Infinity]) {
      const r = checkInvariants(base({ goals: goals({ sessionsPerWeek: s }), pool: { Chest: ["bench", "fly"] } }));
      const chest = r.load.find((l) => l.muscle === "Chest")!;
      // 1..7 sessions, 3 days, Chest on one day, 2 picks x 3 sets: 6 * sessions/3.
      expect(chest.weeklySets).toBeLessThanOrEqual(14);
    }
  });

  it("clamps odd picksPerSession, setsPerExercise and suggestionsPerMuscle", () => {
    for (const v of [NaN, 0, -1, 1.5, 1000, Infinity]) {
      const r = checkInvariants(base({ picksPerSession: v, setsPerExercise: v, suggestionsPerMuscle: v, pool: { Chest: ["bench"] } }));
      expect(r.suggestions.length).toBeLessThanOrEqual(3 * MUSCLE_GROUPS.length);
    }
    expect(reviewSetup(base({ suggestionsPerMuscle: 0 })).suggestions).toEqual([]);
    expect(reviewSetup(base({ suggestionsPerMuscle: -5 })).suggestions).toEqual([]);
    expect(reviewSetup(base({ suggestionsPerMuscle: 1 })).suggestions.filter((s) => s.muscle === "Chest")).toHaveLength(1);
  });

  it("handles non-finite and negative own targets without NaN output", () => {
    const r = checkInvariants(base({ goals: goals({ targets: { Chest: NaN, Back: -3, Biceps: Infinity, Triceps: 0 } }), pool: { Chest: ["bench"], Back: ["row"] } }));
    for (const l of r.load) expect(Number.isNaN(l.target)).toBe(false);
  });

  it("an own target of 0 means no below_target finding for that muscle", () => {
    const r = reviewSetup(base({ goals: goals({ targets: { Chest: 0 } }), pool: { Chest: ["bench"] } }));
    expect(r.findings.some((f) => f.code === "below_target" && f.muscle === "Chest")).toBe(false);
  });

  it("junk entries in the catalogue do not crash and duplicate ids resolve to the first", () => {
    const cat = [null, ...CAT, ex("bench", "Fake Bench", ["Back"])] as unknown as Exercise[];
    const r = reviewSetup(base({ catalogue: cat, pool: { Chest: ["bench", "fly"] } }));
    expect(r.load.find((l) => l.muscle === "Chest")?.poolSize).toBe(2);
  });

  it("an empty catalogue gives findings but no suggestions", () => {
    const r = reviewSetup(base({ catalogue: [] }));
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.suggestions).toEqual([]);
  });

  it("an equipment filter that nothing matches gives no suggestions, not an error", () => {
    const r = reviewSetup(base({ equipment: ["Bands"] }));
    expect(r.suggestions).toEqual([]);
  });

  it("a custom exercise object in the pool counts and is never suggested under another muscle", () => {
    const custom = ex("custom1", "My Special Press", ["Chest", "Triceps"], { equipment: "Other" });
    const catWithCustom = [...CAT, custom];
    const r = checkInvariants(base({ catalogue: catWithCustom, pool: { Chest: [custom] } }));
    expect(r.load.find((l) => l.muscle === "Chest")?.poolSize).toBe(1);
    expect(r.suggestions.some((s) => s.exercise_id === "custom1")).toBe(false);
  });

  it("a custom pool exercise absent from the catalogue still counts as pool", () => {
    const custom = ex("only-mine", "Cable Thing", ["Chest"]);
    const r = reviewSetup(base({ pool: { Chest: [custom, "bench"] } }));
    expect(r.load.find((l) => l.muscle === "Chest")?.poolSize).toBe(2);
    expect(r.findings.some((f) => f.muscle === "Chest" && (f.code === "no_exercises" || f.code === "one_exercise"))).toBe(false);
  });
});

describe("coachReview QA: finding logic boundaries", () => {
  it("a muscle repeated on every day of a 3-day, 3-session split gets 3 days", () => {
    const split: Split = { name: "fb", days: [0, 1, 2].map((i) => ({ name: `D${i}`, muscles: ["Chest" as MuscleGroup, "Chest" as MuscleGroup] })) };
    const r = reviewSetup(base({ split, pool: { Chest: ["bench", "fly"] } }));
    expect(r.load[0]).toMatchObject({ muscle: "Chest", splitDays: 3, poolSize: 2, weeklySets: 18 });
  });

  it("focus muscle with one exercise on one day reports both focus findings, once each", () => {
    const r = reviewSetup(base({ goals: goals({ focusMuscles: ["Chest", "Chest"] }), pool: { Chest: ["bench"] } }));
    const chest = r.findings.filter((f) => f.muscle === "Chest").map((f) => f.code);
    expect(chest.filter((c) => c === "focus_few_exercises")).toHaveLength(1);
    expect(chest.filter((c) => c === "focus_few_days")).toHaveLength(1);
    expect(chest).not.toContain("one_exercise");
  });

  it("a focus muscle outside the split with an empty pool gets not_in_split and focus_few_exercises", () => {
    const r = reviewSetup(base({ goals: goals({ focusMuscles: ["Calves"] }) }));
    const calves = r.findings.filter((f) => f.muscle === "Calves").map((f) => f.code);
    expect(calves).toContain("not_in_split");
    expect(calves).toContain("focus_few_exercises");
    expect(r.load.some((l) => l.muscle === "Calves")).toBe(false);
  });

  it("an empty split gives only no_split, and no load rows", () => {
    const r = reviewSetup(base({ split: { name: "e", days: [] }, goals: goals({ focusMuscles: ["Chest"], targets: { Back: 12 } }) }));
    expect(r.findings.map((f) => f.code)).toContain("no_split");
    expect(r.findings.map((f) => f.code)).not.toContain("not_in_split");
    expect(r.load).toEqual([]);
  });

  it("too_many_days triggers only when days exceed sessions (equal is fine)", () => {
    expect(reviewSetup(base({ goals: goals({ sessionsPerWeek: 3 }) })).findings.some((f) => f.code === "too_many_days")).toBe(false);
    expect(reviewSetup(base({ goals: goals({ sessionsPerWeek: 2 }) })).findings.some((f) => f.code === "too_many_days")).toBe(true);
  });

  it("below_target is not raised for an empty pool (only no_exercises)", () => {
    const r = reviewSetup(base());
    expect(r.findings.some((f) => f.code === "below_target")).toBe(false);
    expect(r.findings.filter((f) => f.code === "no_exercises").length).toBe(r.load.length);
  });

  it("below_target boundary: exactly 75% of target is not flagged, just under is", () => {
    // Chest, 1 day, sessions 3, split days 3 -> 1x/week. 2 picks x 3 sets = 6 sets.
    const pool = { Chest: ["bench", "fly"] };
    const at = reviewSetup(base({ pool, goals: goals({ targets: { Chest: 8 } }) })); // 6 == 8*0.75
    expect(at.findings.some((f) => f.code === "below_target" && f.muscle === "Chest")).toBe(false);
    const under = reviewSetup(base({ pool, goals: goals({ targets: { Chest: 9 } }) }));
    expect(under.findings.some((f) => f.code === "below_target" && f.muscle === "Chest")).toBe(true);
  });

  it("below_target is warn for focus muscles and info otherwise", () => {
    const pool = { Chest: ["bench", "fly"], Back: ["row", "bench"] };
    const r = reviewSetup(base({ pool, goals: goals({ focusMuscles: ["Chest"], targets: { Chest: 20, Back: 20 } }) }));
    expect(r.findings.find((f) => f.code === "below_target" && f.muscle === "Chest")?.severity).toBe("warn");
    expect(r.findings.find((f) => f.code === "below_target" && f.muscle === "Back")?.severity).toBe("info");
  });

  it("reviewDefaultTarget stays within 4..24 for every combination", () => {
    for (const goalType of ["build_muscle", "strength", "general", "fat_loss"] as const)
      for (const experience of ["beginner", "intermediate", "advanced"] as const)
        for (const s of [0, 1, 2, 3, 4, 5, 7, 99])
          for (const m of MUSCLE_GROUPS)
            for (const focus of [[], [m]]) {
              const t = reviewDefaultTarget(m, { goalType, experience, sessionsPerWeek: s, focusMuscles: focus });
              expect(t).toBeGreaterThanOrEqual(4);
              expect(t).toBeLessThanOrEqual(24);
            }
  });

  it("messages carry no emojis", () => {
    const r = reviewSetup(base({ goals: goals({ focusMuscles: ["Chest", "Calves"] }), pool: { Chest: ["bench"] } }));
    const text = [...r.findings.map((f) => f.message), ...r.suggestions.map((s) => s.reason)].join(" ");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("coachReview QA: suggestions", () => {
  it("never suggests an exercise already in the pool even when it is listed under another muscle", () => {
    const r = reviewSetup(base({ pool: { Quads: ["squat"] } }));
    expect(r.suggestions.some((s) => s.exercise_id === "squat")).toBe(false);
  });

  it("equipment filter is applied to all suggestions and an object pool entry may violate it without effect", () => {
    const r = checkInvariants(base({ equipment: ["Dumbbell"], pool: { Chest: ["bench"] } }));
    expect(r.suggestions.every((s) => s.exercise.equipment === "Dumbbell")).toBe(true);
  });

  it("a muscle with every candidate already in the pool gets findings but no suggestions", () => {
    const r = reviewSetup(base({ pool: { Biceps: ["curl", "hcurl"] }, suggestionsPerMuscle: 3 }));
    expect(r.findings.some((f) => f.muscle === "Biceps" && f.code === "below_target" || f.muscle === "Biceps")).toBeTruthy();
    expect(r.suggestions.filter((s) => s.muscle === "Biceps")).toEqual([]);
  });

  it("is deterministic regardless of catalogue order", () => {
    const a = reviewSetup(base({ pool: { Chest: ["bench"] } }));
    const b = reviewSetup(base({ pool: { Chest: ["bench"] }, catalogue: [...CAT].reverse() }));
    expect(b.suggestions.map((s) => s.exercise_id).sort()).toEqual(a.suggestions.map((s) => s.exercise_id).sort());
  });
});

describe("coachReview QA: fuzz and size", () => {
  it("holds its invariants over 200 seeded random setups", () => {
    const rand = rng(20261026);
    for (let i = 0; i < 200; i++) {
      const cat = makeCatalogue(5 + Math.floor(rand() * 120), rand);
      const dayCount = Math.floor(rand() * 8);
      const days = Array.from({ length: dayCount }, (_, d) => ({
        name: `D${d}`,
        muscles: MUSCLE_GROUPS.filter(() => rand() < 0.25),
      }));
      const pool: ReviewPool = {};
      for (const m of MUSCLE_GROUPS) {
        if (rand() < 0.5) pool[m] = cat.filter(() => rand() < 0.05).map((e) => (rand() < 0.5 ? e.id : e));
      }
      const focusMuscles = MUSCLE_GROUPS.filter(() => rand() < 0.1);
      const targets: ReviewGoals["targets"] = {};
      for (const m of MUSCLE_GROUPS) if (rand() < 0.15) targets[m] = Math.floor(rand() * 30);
      const equipment = rand() < 0.5 ? [] : EQUIP.filter(() => rand() < 0.5);
      const inp: ReviewInput = {
        goals: goals({ sessionsPerWeek: Math.floor(rand() * 9), focusMuscles, targets }),
        split: { name: "f", days },
        pool,
        catalogue: cat,
        equipment,
      };
      const r = checkInvariants(inp);
      expect(JSON.stringify(reviewSetup(inp))).toBe(JSON.stringify(r));
    }
  });

  it("handles a 3000 exercise catalogue and a 60 day split quickly", () => {
    const rand = rng(7);
    const cat = makeCatalogue(3000, rand);
    const days = Array.from({ length: 60 }, (_, d) => ({ name: `D${d}`, muscles: MUSCLE_GROUPS.filter(() => rand() < 0.3) }));
    const t = Date.now();
    const r = checkInvariants({ goals: goals({ focusMuscles: ["Chest", "Back"] }), split: { name: "huge", days }, pool: {}, catalogue: cat, equipment: [] });
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.findings.some((f) => f.code === "too_many_days")).toBe(true);
  });

  it("handles a huge pool without error", () => {
    const rand = rng(11);
    const cat = makeCatalogue(500, rand);
    const pool: ReviewPool = {};
    for (const m of MUSCLE_GROUPS) pool[m] = cat.map((e) => e.id);
    expect(() => checkInvariants({ goals: goals(), split: SPLIT, pool, catalogue: cat, equipment: [] })).not.toThrow();
  });
});
