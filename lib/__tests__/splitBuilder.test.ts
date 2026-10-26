import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import realCatalogue from "../../data/exercises.json";
import {
  DEFAULT_MUSCLES,
  MAX_DAYS,
  MIN_DAYS,
  balanceDays,
  buildSplit,
  daysFromRequest,
  excludedMuscles,
  mentionedMuscles,
  muscleWeights,
  namedMuscles,
  textKey,
  type SuggestSplitInput,
} from "../splitBuilder";
import * as viaAi from "../ai/suggest-split";
import { mentionedMuscles as coachMentioned } from "../ai/ask-coach";
import { textKey as socialTextKey } from "../ai/social-import";
import type { Exercise } from "../exercises";

const CAT = realCatalogue as unknown as Exercise[];
const BY_ID = new Map(CAT.map((e) => [e.id, e]));

const input = (over: Partial<SuggestSplitInput> = {}): SuggestSplitInput => ({
  favorites: [],
  request: null,
  days_per_week: null,
  equipment: [],
  ...over,
});

describe("lib/splitBuilder.ts is client-safe", () => {
  const src = readFileSync(join(__dirname, "..", "splitBuilder.ts"), "utf8");
  const imports = [...src.matchAll(/^\s*(import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((m) => ({ text: m[0], from: m[2] }));

  it("imports nothing from lib/ai, React or Dexie", () => {
    expect(imports.length).toBeGreaterThan(0);
    for (const { from } of imports) {
      expect(from).not.toMatch(/(^|\/)ai(\/|$)|@\/lib\/ai|^react|dexie/);
    }
    expect(src).not.toMatch(/require\(|import\(/);
    expect(src).not.toMatch(/^["']use (client|server)["']/m);
  });

  it("only imports types, plus runtime values from ./muscles", () => {
    for (const { text, from } of imports) {
      if (from === "./muscles") continue;
      expect(text, from).toMatch(/^\s*import type\b/);
    }
  });
});

describe("re-exports", () => {
  it("lib/ai/suggest-split re-exports the same functions", () => {
    expect(viaAi.buildSplit).toBe(buildSplit);
    expect(viaAi.daysFromRequest).toBe(daysFromRequest);
    expect(viaAi.muscleWeights).toBe(muscleWeights);
    expect(viaAi.DEFAULT_MUSCLES).toBe(DEFAULT_MUSCLES);
    const favs = ["Barbell_Bench_Press_-_Medium_Grip", "Barbell_Squat", "Barbell_Curl"];
    for (let n = MIN_DAYS; n <= MAX_DAYS; n++) {
      const i = input({ favorites: favs, request: "more glutes", days_per_week: n });
      expect(viaAi.buildSplit(i, BY_ID)).toEqual(buildSplit(i, BY_ID));
    }
  });

  it("lib/ai/ask-coach still exports mentionedMuscles: the negation-blind namedMuscles", () => {
    expect(coachMentioned).toBe(namedMuscles);
    expect(coachMentioned("why are my arms and legs not growing?")).toEqual(["Biceps", "Triceps", "Quads", "Hamstrings", "Glutes"]);
  });

  it("textKey matches the lib/ai/social-import copy", () => {
    for (const s of ["Bench Presses", "Glutes & Hamstrings!", "  Abs/Core  ", "class", "Lats-Pulldowns", "Ünïcode Lifts", ""]) {
      expect(textKey(s), s).toBe(socialTextKey(s));
    }
  });
});

describe("buildSplit (client-side, no key)", () => {
  it("works from favourites alone", () => {
    const r = buildSplit(input({ favorites: ["Barbell_Bench_Press_-_Medium_Grip", "Barbell_Curl", "Barbell_Squat"] }), BY_ID);
    expect(r.source).toBe("rules");
    expect(r.split).toEqual({
      name: "Push / Pull / Legs",
      days: [
        { name: "Push", muscles: ["Chest"] },
        { name: "Pull", muscles: ["Biceps"] },
        { name: "Legs", muscles: ["Quads"] },
      ],
    });
  });

  it("ignores ids it does not know (custom exercises)", () => {
    expect(buildSplit(input({ favorites: ["custom-1"] }), BY_ID)).toEqual(buildSplit(input(), BY_ID));
  });

  it("balanceDays never repeats a group back to back when another is left", () => {
    for (let n = 1; n <= MAX_DAYS; n++) {
      const out = balanceDays(["A", "B", "C"], [5, 1, 1], n);
      expect(out).toHaveLength(n);
      for (let i = 1; i < out.length; i++) expect(out[i]).not.toBe(out[i - 1]);
    }
  });
});

describe("negated requests", () => {
  const LEGS = ["Quads", "Hamstrings", "Glutes"] as const;
  const legDays = (r: SuggestSplitInput) =>
    buildSplit(r, BY_ID).split.days.filter((d) => d.muscles.some((m) => (LEGS as readonly string[]).includes(m))).length;

  it.each(["no legs", "not legs", "skip legs", "without legs", "except legs", "avoid legs", "don't want legs", "dont want legs", "I do not want legs", "no more legs", "skip training my legs"])(
    "%s: legs are not mentioned and are left out",
    (req) => {
      expect(mentionedMuscles(req)).toEqual([]);
      expect(excludedMuscles(req)).toEqual(["Quads", "Hamstrings", "Glutes", "Hips/Adductors/Abductors", "Calves"]);
      expect(legDays(input({ request: req }))).toBeLessThanOrEqual(legDays(input()));
      expect(legDays(input({ request: req }))).toBe(0);
    },
  );

  it("negates single muscles and or-lists, keeps the rest", () => {
    expect(mentionedMuscles("more chest, no biceps")).toEqual(["Chest"]);
    expect(excludedMuscles("more chest, no biceps")).toEqual(["Biceps"]);
    expect(mentionedMuscles("no chest or arms, just back")).toEqual(["Back"]);
    expect(excludedMuscles("no chest or arms")).toEqual(["Chest", "Biceps", "Triceps"]);
    expect(mentionedMuscles("no lower back")).toEqual([]);
    expect(mentionedMuscles("skip legs but more glutes")).toEqual(["Glutes"]);
    expect(excludedMuscles("skip legs but more glutes")).not.toContain("Glutes");
  });

  it("a muscle named after a word like 'not' later in the sentence still counts", () => {
    expect(mentionedMuscles("why are my legs not growing")).toEqual(["Quads", "Hamstrings", "Glutes"]);
    expect(mentionedMuscles("legs, not chest")).toEqual(["Quads", "Hamstrings", "Glutes"]);
    expect(mentionedMuscles("I have no idea why my arms are small")).toEqual(["Biceps", "Triceps"]);
  });

  it("'no legs' with 4 days builds upper-body days only", () => {
    const { split } = buildSplit(input({ request: "no legs", days_per_week: 4 }), BY_ID);
    expect(split.days).toHaveLength(4);
    for (const d of split.days) {
      expect(d.muscles.length).toBeGreaterThan(0);
      expect(d.muscles.some((m) => (LEGS as readonly string[]).includes(m) || m === "Calves")).toBe(false);
    }
  });

  it("'only upper body' drops leg days when there are no favourites", () => {
    for (const req of ["only upper body", "just upper body please", "upper body only", "upper only"]) {
      expect(excludedMuscles(req)).toEqual(["Quads", "Hamstrings", "Glutes", "Hips/Adductors/Abductors", "Calves"]);
      for (let n = MIN_DAYS; n <= MAX_DAYS; n++) {
        const { split } = buildSplit(input({ request: req, days_per_week: n }), BY_ID);
        expect(split.days).toHaveLength(n);
        expect(split.days.every((d) => d.muscles.every((m) => !(LEGS as readonly string[]).includes(m) && m !== "Calves"))).toBe(true);
      }
    }
    expect(excludedMuscles("only upper body and calves")).not.toContain("Calves");
  });

  it("favourites and focus muscles are never dropped by a negation", () => {
    const { split } = buildSplit(input({ favorites: ["Barbell_Squat"], request: "no legs" }), BY_ID);
    expect(split.days.some((d) => d.muscles.includes("Quads"))).toBe(true);
    const f = buildSplit(input({ request: "no legs", focus_muscles: ["Glutes"] }), BY_ID).split;
    expect(f.days.filter((d) => d.muscles.includes("Glutes")).length).toBeGreaterThanOrEqual(2);
  });

  it("excluding everything falls back to the default split", () => {
    const { split } = buildSplit(input({ request: "no chest, no back, no lats, no shoulders, no arms, no abs, no legs, no calves" }), BY_ID);
    expect(split.days).toHaveLength(3);
    for (const d of split.days) expect(d.muscles.length).toBeGreaterThan(0);
  });

  it("is re-exported by lib/ai/suggest-split", () => {
    expect(viaAi.excludedMuscles).toBe(excludedMuscles);
  });
});

describe("'not' + training verb is not a negation", () => {
  it.each(["I am not training chest enough", "I am not training chest enough, 4 days", "Why am I not hitting my chest enough", "I do not train chest enough"])(
    "%s: Chest is named, not excluded, and stays in the split",
    (req) => {
      expect(excludedMuscles(req)).toEqual([]);
      expect(mentionedMuscles(req)).toContain("Chest");
      expect(buildSplit(input({ request: req }), BY_ID).split.days.some((d) => d.muscles.includes("Chest"))).toBe(true);
    },
  );

  it("I do not train arms enough: arms are named, not excluded", () => {
    expect(excludedMuscles("I do not train arms enough")).toEqual([]);
    expect(mentionedMuscles("I do not train arms enough")).toEqual(["Biceps", "Triceps"]);
  });

  it("explicit negators still take a verb", () => {
    expect(excludedMuscles("skip training my legs")).toEqual(["Quads", "Hamstrings", "Glutes", "Hips/Adductors/Abductors", "Calves"]);
    expect(excludedMuscles("I don't want to train chest")).toEqual(["Chest"]);
    expect(excludedMuscles("not chest")).toEqual(["Chest"]);
  });
});

describe("namedMuscles ignores negation", () => {
  it("names every muscle the text mentions", () => {
    expect(namedMuscles("no legs")).toEqual(["Quads", "Hamstrings", "Glutes"]);
    expect(namedMuscles("Am I not training chest enough?")).toEqual(["Chest"]);
    expect(namedMuscles("more chest, no biceps")).toEqual(["Chest", "Biceps"]);
    expect(namedMuscles("hello")).toEqual([]);
  });
});
