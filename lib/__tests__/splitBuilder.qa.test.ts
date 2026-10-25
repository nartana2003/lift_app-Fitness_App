/**
 * Independent QA for lib/splitBuilder.ts (GEN-02): fixed-seed property tests,
 * phrasing of typed requests, the user's own 3-day setup and the import
 * boundary of the client-safe module.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import catalogueJson from "../../data/exercises.json";
import type { Exercise } from "../exercises";
import { MUSCLE_GROUPS, type MuscleGroup } from "../muscles";
import {
  DEFAULT_DAYS,
  MAX_NAME,
  balanceDays,
  buildSplit,
  daysFromRequest,
  labelRepeats,
  mentionedMuscles,
  splitName,
  textKey,
  type SuggestSplitInput,
} from "../splitBuilder";

const CAT = catalogueJson as unknown as Exercise[];
const BY_ID = new Map(CAT.map((e) => [e.id, e]));

// --- helpers ----------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

const base = (p: Partial<SuggestSplitInput> = {}): SuggestSplitInput => ({
  favorites: [],
  request: null,
  days_per_week: null,
  equipment: [],
  ...p,
});

const baseName = (n: string) => n.replace(/ [A-F]$/, "");
const idsFor = (...ms: MuscleGroup[]) => ms.map((m) => CAT.find((e) => e.muscle_groups[0] === m && e.muscle_groups.length === 1)!.id);

const REQUESTS = [
  null,
  "I want more arms and shoulders",
  "4 days a week",
  "four days a week please",
  "arms and shoulders",
  "no legs",
  "only upper body",
  "BIGGER CHEST AND BACK, 5 days",
  "wanna hit glutes n abs",
  "legs legs legs",
  "ARMS!!! 6 days",
  "sholders and bicpes",
  "😀💪 chest 😀",
  "x".repeat(400),
  "chest ".repeat(66),
  "2 days",
  "three times a week, calves and neck",
  "forearms traps lower back lats",
];
const GOALS = [undefined, "build_muscle", "strength", "general", "fat_loss"] as const;
const EXPS = [undefined, "beginner", "intermediate", "advanced"] as const;

function randomInput(r: () => number): SuggestSplitInput {
  const nf = Math.floor(r() * 31);
  const favorites: string[] = [];
  while (favorites.length < nf) {
    const id = CAT[Math.floor(r() * CAT.length)].id;
    if (!favorites.includes(id)) favorites.push(id);
  }
  // sometimes focus on a narrow muscle family to stress the grouping
  const narrow = r() < 0.25;
  if (narrow) {
    favorites.length = 0;
    const m = MUSCLE_GROUPS[Math.floor(r() * MUSCLE_GROUPS.length)];
    for (const e of CAT) if (e.muscle_groups.includes(m) && favorites.length < 1 + Math.floor(r() * 4)) favorites.push(e.id);
  }
  const focus: MuscleGroup[] = [];
  const nfoc = r() < 0.5 ? 0 : Math.floor(r() * 9);
  while (focus.length < nfoc) {
    const m = MUSCLE_GROUPS[Math.floor(r() * MUSCLE_GROUPS.length)];
    if (!focus.includes(m)) focus.push(m);
  }
  const input: SuggestSplitInput = {
    favorites,
    request: REQUESTS[Math.floor(r() * REQUESTS.length)],
    days_per_week: r() < 0.6 ? 2 + Math.floor(r() * 5) : null,
    equipment: [],
  };
  const g = GOALS[Math.floor(r() * GOALS.length)];
  const x = EXPS[Math.floor(r() * EXPS.length)];
  if (g) input.goal_type = g;
  if (x) input.experience = x;
  if (r() < 0.6) input.focus_muscles = focus;
  return input;
}

// --- property tests -----------------------------------------------------------

describe("buildSplit: fixed-seed property tests", () => {
  const r = rng(20261025);
  const cases = Array.from({ length: 600 }, () => randomInput(r));

  it("day count, no empty day, valid muscles, valid names", () => {
    for (const input of cases) {
      const n = input.days_per_week ?? daysFromRequest(input.request) ?? DEFAULT_DAYS;
      const { split, source, notes } = buildSplit(input, BY_ID);
      const ctx = JSON.stringify(input);
      expect(source, ctx).toBe("rules");
      expect(split.days.length, ctx).toBe(n);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(6);
      for (const d of split.days) {
        expect(d.muscles.length, ctx).toBeGreaterThan(0);
        expect(new Set(d.muscles).size, ctx).toBe(d.muscles.length);
        for (const m of d.muscles) expect(MUSCLE_GROUPS as readonly string[], ctx).toContain(m);
        expect(d.name.length).toBeGreaterThan(0);
        expect(d.name.length).toBeLessThanOrEqual(MAX_NAME);
      }
      expect(split.name.length).toBeGreaterThan(0);
      expect(split.name.length).toBeLessThanOrEqual(MAX_NAME);
      expect(typeof notes).toBe("string");
      // day names are unique so the user can tell the days apart
      expect(new Set(split.days.map((d) => d.name)).size, ctx).toBe(split.days.length);
    }
  });

  it("every focus muscle is on 2+ days when there are 3+ days, else on 1+", () => {
    for (const input of cases) {
      const { split } = buildSplit(input, BY_ID);
      const need = split.days.length >= 3 ? 2 : 1;
      for (const m of input.focus_muscles ?? []) {
        const on = split.days.filter((d) => d.muscles.includes(m)).length;
        expect(on, `${m} ${JSON.stringify(input)}`).toBeGreaterThanOrEqual(need);
      }
    }
  });

  it("every muscle named in the request lands on 2+ days (3+ day split)", () => {
    for (const input of cases) {
      const { split } = buildSplit(input, BY_ID);
      if (split.days.length < 3 || !input.request) continue;
      for (const m of mentionedMuscles(input.request)) {
        const on = split.days.filter((d) => d.muscles.includes(m)).length;
        expect(on, `${m} ${JSON.stringify(input)}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("every favourite's primary muscle is trained somewhere", () => {
    for (const input of cases) {
      const { split } = buildSplit(input, BY_ID);
      const trained = new Set(split.days.flatMap((d) => d.muscles));
      for (const id of input.favorites) for (const m of BY_ID.get(id)!.muscle_groups) expect(trained.has(m), `${m} ${JSON.stringify(input)}`).toBe(true);
    }
  });

  it("no group on two consecutive days while another group is available, and groups are capped", () => {
    for (const input of cases) {
      const { split } = buildSplit(input, BY_ID);
      const names = split.days.map((d) => baseName(d.name));
      const groups = new Set(names);
      const ctx = JSON.stringify(input) + " -> " + names.join(",");
      if (groups.size > 1) for (let i = 1; i < names.length; i++) expect(names[i], ctx).not.toBe(names[i - 1]);
      const cap = Math.ceil(names.length / groups.size);
      for (const g of groups) expect(names.filter((x) => x === g).length, ctx).toBeLessThanOrEqual(cap);
    }
  });

  it("is deterministic and never mutates deep-frozen inputs", () => {
    const catalogue = deepFreeze(CAT.map((e) => structuredClone(e)));
    const byId = new Map(catalogue.map((e) => [e.id, e]));
    for (const input of cases.slice(0, 200)) {
      const frozen = deepFreeze(structuredClone(input));
      const a = buildSplit(frozen, byId);
      const b = buildSplit(frozen, byId);
      expect(b).toEqual(a);
      expect(frozen).toEqual(input);
      // the result must not alias the frozen input arrays
      for (const d of a.split.days) expect(Object.isFrozen(d.muscles)).toBe(false);
    }
  });

  it("two results never share day or muscle arrays", () => {
    const a = buildSplit(base({ days_per_week: 4, favorites: idsFor("Chest", "Quads") }), BY_ID);
    const b = buildSplit(base({ days_per_week: 4, favorites: idsFor("Chest", "Quads") }), BY_ID);
    a.split.days[0].muscles.push("Neck");
    expect(b.split.days[0].muscles).not.toContain("Neck");
    // Upper appears twice in a 4-day split: mutating one day must not touch the other
    const c = buildSplit(base({ days_per_week: 4, favorites: idsFor("Chest", "Quads") }), BY_ID);
    c.split.days[0].muscles.push("Neck");
    expect(c.split.days[2].muscles).not.toContain("Neck");
  });

  it("unknown favourite ids are ignored, not fatal", () => {
    const res = buildSplit(base({ favorites: ["nope", "__proto__", "constructor"] }), BY_ID);
    expect(res.split.days.length).toBe(3);
  });
});

// --- the user's own setup -------------------------------------------------------

describe("buildSplit: the user's 3-day setup", () => {
  it("legs + glutes + abs / arms + shoulders + back + abs / full body shape from favourites", () => {
    const favorites = idsFor("Quads", "Glutes", "Biceps", "Triceps", "Shoulders", "Back", "Abs/Core");
    const { split } = buildSplit(base({ favorites, days_per_week: 3 }), BY_ID);
    expect(split.days).toHaveLength(3);
    const all = new Set(split.days.flatMap((d) => d.muscles));
    for (const m of ["Quads", "Glutes", "Biceps", "Triceps", "Shoulders", "Back", "Abs/Core"] as MuscleGroup[]) expect(all.has(m)).toBe(true);
    // abs ride with the leg day
    const legs = split.days.find((d) => d.name === "Legs")!;
    expect(legs.muscles).toContain("Abs/Core");
    expect(legs.muscles).toContain("Glutes");
  });

  it("no favourites and no request gives a 3-day balanced default", () => {
    const { split, notes } = buildSplit(base(), BY_ID);
    expect(split.days.map((d) => d.name)).toEqual(["Push", "Pull", "Legs"]);
    expect(notes).toMatch(/favourite/i);
  });

  it("focus on arms and shoulders in the user's 3-day split puts them on two days", () => {
    const { split } = buildSplit(base({ days_per_week: 3, focus_muscles: ["Biceps", "Triceps", "Shoulders"] }), BY_ID);
    for (const m of ["Biceps", "Triceps", "Shoulders"] as MuscleGroup[]) expect(split.days.filter((d) => d.muscles.includes(m)).length).toBeGreaterThanOrEqual(2);
  });

  it("2-day split with a focus puts it on at least one day", () => {
    const { split } = buildSplit(base({ days_per_week: 2, focus_muscles: ["Calves"] }), BY_ID);
    expect(split.days).toHaveLength(2);
    expect(split.days.some((d) => d.muscles.includes("Calves"))).toBe(true);
  });

  it("requests without goal fields behave exactly as before (goal fields do not change the days)", () => {
    const plain = buildSplit(base({ favorites: idsFor("Chest", "Quads"), days_per_week: 4 }), BY_ID);
    const goal = buildSplit(base({ favorites: idsFor("Chest", "Quads"), days_per_week: 4, goal_type: "strength", experience: "advanced" }), BY_ID);
    expect(goal.split).toEqual(plain.split);
  });
});

// --- typed request phrasing -------------------------------------------------------

describe("daysFromRequest and mentionedMuscles: phrasing", () => {
  it.each([
    ["4 days a week", 4],
    ["four days", 4],
    ["Four Days a week", 4],
    ["FIVE DAYS", 5],
    ["3-day split", 3],
    ["5x a week", 5],
    ["3 times a week", 3],
    ["2days", 2],
    ["6 days please", 6],
  ])("%s -> %s", (t, n) => expect(daysFromRequest(t)).toBe(n));

  it.each([
    [null],
    [""],
    ["1 day"],
    ["7 days"],
    ["10 days"],
    ["12 days a week"],
    ["bench 5x5"],
    ["3x10 squats"],
    ["do 3 sets"],
    ["seven days"],
    ["twenty days"],
    ["days"],
    ["💪💪💪"],
  ])("%s -> null", (t) => expect(daysFromRequest(t)).toBeNull());

  it("a huge request does not hang or throw", () => {
    const t0 = Date.now();
    const big = "legs and arms and 4 days ".repeat(20000);
    expect(daysFromRequest(big)).toBe(4);
    expect(mentionedMuscles(big).length).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("finds muscles in mixed case, plural and punctuation", () => {
    expect(mentionedMuscles("ARMS and Shoulders!")).toEqual(expect.arrayContaining(["Biceps", "Triceps", "Shoulders"]));
    expect(mentionedMuscles("more glutes, quads; and abs")).toEqual(expect.arrayContaining(["Glutes", "Quads", "Abs/Core"]));
    expect(mentionedMuscles("lower back")).toContain("Lower back");
  });

  it("emoji, lookalikes and zero-width text yield only known muscles", () => {
    for (const t of ["😀 chest 💪", "c​hest", "ＣＨＥＳＴ", "‮tseuhc", "\u0000\u0001"]) {
      for (const m of mentionedMuscles(t)) expect(MUSCLE_GROUPS as readonly string[]).toContain(m);
    }
  });

  it("textKey is stable for odd input", () => {
    expect(textKey("")).toBe("");
    expect(textKey("   ")).toBe("");
    expect(textKey("Glutes!!!")).toBe("glute");
    expect(textKey("😀")).toBe("");
  });

  it("'4 days a week' in the request sets the day count and days_per_week wins over it", () => {
    expect(buildSplit(base({ request: "4 days a week" }), BY_ID).split.days).toHaveLength(4);
    expect(buildSplit(base({ request: "4 days a week", days_per_week: 2 }), BY_ID).split.days).toHaveLength(2);
    expect(buildSplit(base({ request: "9 days a week" }), BY_ID).split.days).toHaveLength(3);
  });

  it("'arms and shoulders' puts biceps, triceps and shoulders on two days", () => {
    const { split } = buildSplit(base({ request: "arms and shoulders" }), BY_ID);
    for (const m of ["Biceps", "Triceps", "Shoulders"] as MuscleGroup[]) expect(split.days.filter((d) => d.muscles.includes(m)).length).toBeGreaterThanOrEqual(2);
  });

  it("'no legs' must not add extra leg emphasis (negation)", () => {
    const plain = buildSplit(base({}), BY_ID).split;
    const neg = buildSplit(base({ request: "no legs" }), BY_ID).split;
    const legDays = (s: typeof plain) => s.days.filter((d) => d.muscles.some((m) => m === "Quads" || m === "Hamstrings" || m === "Glutes")).length;
    // The user said they do not want leg work: it must not get MORE leg days than with no request.
    expect(legDays(neg)).toBeLessThanOrEqual(legDays(plain));
  });

  it("'no legs' does not put leg muscles on every day", () => {
    const { split } = buildSplit(base({ request: "no legs", days_per_week: 4 }), BY_ID);
    const withQuads = split.days.filter((d) => d.muscles.includes("Quads")).length;
    expect(withQuads).toBeLessThan(split.days.length);
  });

  it("'only upper body' still returns a valid split", () => {
    const { split } = buildSplit(base({ request: "only upper body" }), BY_ID);
    expect(split.days).toHaveLength(3);
  });
});

// --- balanceDays / labelRepeats / splitName ----------------------------------------

describe("helpers", () => {
  it("balanceDays handles empty and non-positive input", () => {
    expect(balanceDays([], [], 3)).toEqual([]);
    expect(balanceDays(["a"], [1], 0)).toEqual([]);
    expect(balanceDays(["a"], [1], -2)).toEqual([]);
  });

  it("balanceDays with one group repeats it, with more groups than days uses the first n", () => {
    expect(balanceDays(["a"], [1], 3)).toEqual(["a", "a", "a"]);
    expect(balanceDays(["a", "b", "c"], [1, 1, 1], 2)).toHaveLength(2);
  });

  it("balanceDays property: counts within cap, no adjacent repeat when 2+ groups", () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const g = 1 + Math.floor(r() * 3);
      const n = 2 + Math.floor(r() * 5);
      const groups = Array.from({ length: g }, (_, k) => k);
      const w = groups.map(() => r() * 10);
      const out = balanceDays(groups, w, n);
      expect(out).toHaveLength(n);
      const cap = Math.ceil(n / g);
      for (const k of groups) expect(out.filter((x) => x === k).length).toBeLessThanOrEqual(cap);
      if (g > 1) for (let j = 1; j < n; j++) expect(out[j], `${g} ${n} ${out}`).not.toBe(out[j - 1]);
    }
  });

  it("labelRepeats keeps names within MAX_NAME and unique even for very long names", () => {
    const long = "x".repeat(MAX_NAME);
    const out = labelRepeats([
      { name: long, muscles: ["Chest"] },
      { name: long, muscles: ["Back"] },
    ]);
    expect(out[0].name.length).toBeLessThanOrEqual(MAX_NAME);
    expect(out[0].name).not.toBe(out[1].name);
  });

  it("labelRepeats does not mutate its input", () => {
    const days = deepFreeze([
      { name: "Push", muscles: ["Chest" as MuscleGroup] },
      { name: "Push", muscles: ["Chest" as MuscleGroup] },
    ]);
    expect(() => labelRepeats(days)).not.toThrow();
  });

  it("splitName falls back to 'N-day split' when the joined names are too long", () => {
    const days = Array.from({ length: 6 }, (_, i) => ({ name: `Long day number ${i}`, muscles: ["Chest" as MuscleGroup] }));
    expect(splitName(days)).toBe("6-day split");
  });
});

// --- import boundary --------------------------------------------------------------

describe("lib/splitBuilder.ts stays client-safe", () => {
  const src = readFileSync(join(__dirname, "..", "splitBuilder.ts"), "utf8");
  const imports = [...src.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gms)].map((m) => ({ type: !!m[1], from: m[2] }));

  it("imports nothing from lib/ai, React, Dexie, offline, supabase or next", () => {
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) {
      expect(i.from).not.toMatch(/ai|react|dexie|offline|supabase|next|anthropic/i);
      expect(i.from.startsWith("./") || i.from.startsWith("../")).toBe(true);
    }
    expect(src).not.toMatch(/require\(|import\(/);
  });

  it("only lib/muscles is imported at runtime; every other import is type-only", () => {
    const runtime = imports.filter((i) => !i.type).map((i) => i.from);
    expect(runtime.every((f) => f === "./muscles")).toBe(true);
  });

  it("has no 'use client' / server-only marker and no process.env access", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/use client|server-only|process\.env/);
  });
});
