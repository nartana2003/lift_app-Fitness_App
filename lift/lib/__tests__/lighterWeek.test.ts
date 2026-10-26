import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LIGHTER_PERCENT,
  LIGHTER_MAX_PERCENT,
  LIGHTER_MIN_PERCENT,
  PLATEAU_APPLIED_KEY,
  activeLighterWeek,
  lighterWeekSuggestion,
  type LighterWeek,
} from "../lighterWeek";
import { DELOAD_MAX, DELOAD_MIN, RULE_DELOAD_PERCENT } from "../ai/plateau-fix";
import { APPLIED_KEY, applyFix, type Fix } from "../../components/progress/PlateauCard";
import { db } from "../offline/db";
import type { LoggedSet } from "../overload";

const NOW = new Date("2026-10-26T10:00:00Z");
const BENCH = "bench";

const rec = (over: Record<string, unknown> = {}) => ({
  kind: "deload",
  headline: "Take a lighter week",
  applied_at: "2026-10-25T10:00:00.000Z",
  until: "2026-11-01T10:00:00.000Z",
  deload_percent: 60,
  deload_weight: 57.5,
  ...over,
});

const lw = (over: Partial<LighterWeek> = {}): LighterWeek => ({ percent: 60, weight: null, until: "2026-11-01T10:00:00.000Z", ...over });

const work = (n: number, reps: number, weight: number): LoggedSet[] => Array.from({ length: n }, () => ({ reps, weight }));

describe("constants match their sources", () => {
  it("uses the same meta key and bounds as the plateau fix", () => {
    expect(PLATEAU_APPLIED_KEY).toBe(APPLIED_KEY);
    expect(DEFAULT_LIGHTER_PERCENT).toBe(RULE_DELOAD_PERCENT);
    expect([LIGHTER_MIN_PERCENT, LIGHTER_MAX_PERCENT]).toEqual([DELOAD_MIN, DELOAD_MAX]);
  });
});

describe("activeLighterWeek", () => {
  it("returns the running deload for the lift", () => {
    expect(activeLighterWeek({ [BENCH]: rec() }, BENCH, NOW)).toEqual({ percent: 60, weight: 57.5, until: "2026-11-01T10:00:00.000Z" });
  });

  it("is null with no record, another lift, or a non-deload fix", () => {
    expect(activeLighterWeek(undefined, BENCH, NOW)).toBeNull();
    expect(activeLighterWeek({}, BENCH, NOW)).toBeNull();
    expect(activeLighterWeek({ squat: rec() }, BENCH, NOW)).toBeNull();
    expect(activeLighterWeek({ [BENCH]: rec({ kind: "rep_range" }) }, BENCH, NOW)).toBeNull();
    expect(activeLighterWeek({ [BENCH]: rec({ kind: "extra_set" }) }, BENCH, NOW)).toBeNull();
  });

  it("is null once the lighter week has ended or before it starts", () => {
    expect(activeLighterWeek({ [BENCH]: rec({ until: "2026-10-26T10:00:00.000Z" }) }, BENCH, NOW)).toBeNull();
    expect(activeLighterWeek({ [BENCH]: rec({ until: "2026-10-20T10:00:00.000Z" }) }, BENCH, NOW)).toBeNull();
    expect(activeLighterWeek({ [BENCH]: rec({ applied_at: "2026-10-27T10:00:00.000Z" }) }, BENCH, NOW)).toBeNull();
  });

  it("is null for malformed records", () => {
    for (const bad of [null, "x", [], 7, { [BENCH]: null }, { [BENCH]: "deload" }, { [BENCH]: rec({ until: 5 }) }, { [BENCH]: rec({ until: "soon" }) }]) {
      expect(activeLighterWeek(bad, BENCH, NOW)).toBeNull();
    }
    expect(activeLighterWeek([rec()], "0", NOW)).toBeNull();
  });

  it("does not read inherited keys", () => {
    expect(activeLighterWeek({}, "toString", NOW)).toBeNull();
    expect(activeLighterWeek({}, "__proto__", NOW)).toBeNull();
  });

  it("falls back to the rule percent and no weight for older or bad records", () => {
    const old = { kind: "deload", headline: "h", applied_at: "2026-10-25T10:00:00.000Z", until: "2026-11-01T10:00:00.000Z" };
    expect(activeLighterWeek({ [BENCH]: old }, BENCH, NOW)).toEqual({ percent: DEFAULT_LIGHTER_PERCENT, weight: null, until: old.until });
    for (const p of [10, 95, 60.5, "60", null]) {
      expect(activeLighterWeek({ [BENCH]: rec({ deload_percent: p }) }, BENCH, NOW)!.percent).toBe(DEFAULT_LIGHTER_PERCENT);
    }
    for (const w of [0, -5, 2000, Number.NaN, "57.5", null]) {
      expect(activeLighterWeek({ [BENCH]: rec({ deload_weight: w }) }, BENCH, NOW)!.weight).toBeNull();
    }
    expect(activeLighterWeek({ [BENCH]: rec({ deload_percent: 75 }) }, BENCH, NOW)!.percent).toBe(75);
  });
});

describe("lighterWeekSuggestion", () => {
  const range = { min: 8, max: 12 };

  it("uses the saved lighter weight, same sets, bottom of the range", () => {
    const s = lighterWeekSuggestion(work(3, 10, 100), range, "Barbell", lw({ weight: 57.5 }))!;
    expect(s).toMatchObject({ sets: 3, reps: 8, weight: 57.5 });
    expect(s.reason).toBe("Lighter week: about 60% of your usual weight. Keep every set easy.");
  });

  it("works out percent of last time's top weight, rounded to the equipment step", () => {
    expect(lighterWeekSuggestion(work(3, 10, 100), range, "Barbell", lw())!.weight).toBe(60);
    expect(lighterWeekSuggestion(work(3, 10, 95), range, "Barbell", lw())!.weight).toBe(57.5);
    expect(lighterWeekSuggestion(work(2, 10, 31), range, "Dumbbell", lw({ percent: 70 }))!.weight).toBe(22);
  });

  it("is never heavier than last time", () => {
    expect(lighterWeekSuggestion(work(3, 10, 50), range, "Barbell", lw({ weight: 80 }))!.weight).toBe(50);
  });

  it("is lighter than the normal progression would be", () => {
    const s = lighterWeekSuggestion(work(3, 12, 100), range, "Barbell", lw())!;
    expect(s.weight).toBeLessThan(100);
  });

  it("ignores warm-ups and counts the top-weight sets", () => {
    const last: LoggedSet[] = [{ reps: 10, weight: 40, is_warmup: true }, ...work(2, 10, 100), { reps: 10, weight: 90 }];
    expect(lighterWeekSuggestion(last, range, "Barbell", lw())).toMatchObject({ sets: 2, weight: 60 });
  });

  it("drops reps instead of weight for bodyweight", () => {
    expect(lighterWeekSuggestion(work(3, 10, 0), range, "Body Only", lw())).toMatchObject({ sets: 3, reps: 5, weight: 0 });
    expect(lighterWeekSuggestion(work(3, 10, 0), { min: 1, max: 3 }, "Body Only", lw({ percent: 40 }))!.reps).toBe(1);
  });

  it("keeps a light lift above zero", () => {
    expect(lighterWeekSuggestion(work(3, 10, 2), range, "Barbell", lw({ percent: 40 }))!.weight).toBe(2);
    expect(lighterWeekSuggestion(work(3, 10, 5), range, "Barbell", lw({ percent: 40 }))!.weight).toBe(2.5);
  });

  it("is null with no working sets last time", () => {
    expect(lighterWeekSuggestion([], range, "Barbell", lw())).toBeNull();
    expect(lighterWeekSuggestion([{ reps: 10, weight: 40, is_warmup: true }, { reps: 0, weight: 60 }], range, "Barbell", lw())).toBeNull();
  });
});

describe("Start lighter week round trip", () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  const deload = (over: Partial<Fix> = {}): Fix => ({
    kind: "deload",
    reason: "Five weeks with no progress.",
    rep_range: null,
    swap_exercise_id: null,
    extra_sets: null,
    deload_percent: 70,
    deload_weight: 70,
    duration_weeks: 1,
    ...over,
  });

  it("applyFix saves the deload numbers and the live workout reads them", async () => {
    await applyFix(BENCH, deload(), "Take a lighter week", NOW);
    const stored = (await db.meta.get(PLATEAU_APPLIED_KEY))!.value;
    expect(activeLighterWeek(stored, BENCH, NOW)).toEqual({ percent: 70, weight: 70, until: "2026-11-02T10:00:00.000Z" });
    expect(activeLighterWeek(stored, BENCH, new Date("2026-11-03T10:00:00Z"))).toBeNull();
  });

  it("other fixes save no deload numbers and do not change the suggestion", async () => {
    await applyFix(BENCH, deload({ kind: "extra_set", extra_sets: 1, deload_percent: null, deload_weight: null, duration_weeks: 3 }), "Add a set", NOW);
    const stored = (await db.meta.get(PLATEAU_APPLIED_KEY))!.value as Record<string, object>;
    expect(stored[BENCH]).not.toHaveProperty("deload_percent");
    expect(activeLighterWeek(stored, BENCH, NOW)).toBeNull();
  });
});
