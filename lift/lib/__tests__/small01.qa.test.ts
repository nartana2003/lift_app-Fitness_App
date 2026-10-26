import { describe, expect, it } from "vitest";
import { applySet, bestsFromHistory, emptyBests, prsForNewSets, setPrs, type SetLike } from "../prs";
import {
  DEFAULT_LIGHTER_PERCENT,
  activeLighterWeek,
  lighterWeekSuggestion,
  type LighterWeek,
} from "../lighterWeek";
import { RECAP_MAX_DAYS_OFF, recapSkipFields } from "../stats";

const s = (reps: number, weight: number, is_warmup = false): SetLike => ({ reps, weight, is_warmup });
const NOW = new Date("2026-10-26T12:00:00Z");
const rec = (o: Record<string, unknown> = {}) => ({
  kind: "deload",
  headline: "x",
  applied_at: "2026-10-24T00:00:00Z",
  until: "2026-11-01T00:00:00Z",
  ...o,
});
const map = (o: Record<string, unknown> = {}, id = "bench") => ({ [id]: rec(o) });

describe("prsForNewSets QA", () => {
  const hist = () => bestsFromHistory([[s(10, 60), s(8, 60)], [s(5, 80)]]);

  it("empty input gives empty output", () => {
    expect(prsForNewSets([], hist(), true)).toEqual([]);
  });
  it("tie with the best weight is not a weight PR", () => {
    const out = prsForNewSets([s(5, 80)], hist(), true);
    expect(out).toEqual([[]]);
  });
  it("same weight, more reps: reps PR only if weight seen before", () => {
    expect(prsForNewSets([s(11, 60)], hist(), true)[0]).toContain("reps");
    // new weight 70 never lifted: no reps PR
    expect(prsForNewSets([s(3, 70)], hist(), true)[0]).not.toContain("reps");
  });
  it("repeating a PR set: second identical set is no PR", () => {
    const out = prsForNewSets([s(6, 90), s(6, 90), s(6, 90)], hist(), true);
    expect(out[0]).toContain("weight");
    expect(out[1]).toEqual([]);
    // third set can only add the session volume PR (3*540 > best 1080)
    expect(out[2].filter((p) => p !== "volume")).toEqual([]);
  });
  it("bodyweight / zero weight never PR, even with huge reps", () => {
    expect(prsForNewSets([s(500, 0), s(1000, 0)], hist(), true)).toEqual([[], []]);
    expect(prsForNewSets([s(500, 0)], emptyBests(), true)).toEqual([[]]);
  });
  it("negative reps / weight are ignored", () => {
    expect(prsForNewSets([s(-5, 100), s(5, -100)], hist(), true)).toEqual([[], []]);
  });
  it("warmups never PR and do not raise bests for later sets", () => {
    const out = prsForNewSets([s(5, 200, true), s(5, 85)], hist(), true);
    expect(out[0]).toEqual([]);
    expect(out[1]).toContain("weight");
  });
  it("no history: no celebration at all", () => {
    expect(prsForNewSets([s(5, 500), s(5, 600)], emptyBests(), false)).toEqual([[], []]);
  });
  it("hadHistory true but empty bests (e.g. only deleted sets): zero weight bests means any lift is a weight PR", () => {
    const out = prsForNewSets([s(5, 50)], emptyBests(), true);
    expect(out[0]).toContain("weight");
    expect(out[0]).toContain("e1rm");
    // volume PR needs a prior volume > 0
    expect(out[0]).not.toContain("volume");
  });
  it("volume PR given once, to the first set that crosses it", () => {
    const b = bestsFromHistory([[s(10, 50)]]); // vol 500
    const out = prsForNewSets([s(10, 30), s(10, 30), s(10, 30), s(10, 30)], b, true);
    const vols = out.map((p) => p.includes("volume"));
    expect(vols).toEqual([false, true, false, false]); // 300, 600 > 500
  });
  it("warmup sets do not count toward volume PR", () => {
    const b = bestsFromHistory([[s(10, 50)]]);
    const out = prsForNewSets([s(20, 50, true), s(10, 49)], b, true);
    expect(out.flat()).not.toContain("volume");
  });
  it("decimal weights key correctly (kg conversions)", () => {
    const b = bestsFromHistory([[s(8, 22.5)]]);
    expect(prsForNewSets([s(9, 22.5)], b, true)[0]).toContain("reps");
    expect(prsForNewSets([s(9, 22.50000001)], b, true)[0]).not.toContain("reps");
  });
  it("does not mutate input bests or sets", () => {
    const b = hist();
    const snap = JSON.stringify(b);
    const sets = [s(5, 100)];
    const sn2 = JSON.stringify(sets);
    prsForNewSets(sets, b, true);
    expect(JSON.stringify(b)).toBe(snap);
    expect(JSON.stringify(sets)).toBe(sn2);
  });
  it("one entry per input set (fuzz, fixed seed)", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 200; i++) {
      const n = Math.floor(rnd() * 12);
      const sets = [...Array(n)].map(() => s(Math.floor(rnd() * 15) - 2, Math.round(rnd() * 120) - 5, rnd() < 0.2));
      const out = prsForNewSets(sets, hist(), rnd() < 0.5);
      expect(out).toHaveLength(n);
      expect(out.flat().filter((p) => p === "volume").length).toBeLessThanOrEqual(1);
    }
  });
  it("matches set-by-set manual ticking (setPrs + applySet)", () => {
    const sets = [s(5, 80), s(6, 80), s(3, 90), s(3, 90)];
    let b = hist();
    const manual = sets.map((x) => {
      const p = setPrs(x, b);
      b = applySet(b, x);
      return p;
    });
    const out = prsForNewSets(sets, hist(), true).map((p) => p.filter((t) => t !== "volume"));
    expect(out).toEqual(manual);
  });
});

describe("activeLighterWeek QA", () => {
  it("returns record with explicit percent and weight", () => {
    expect(activeLighterWeek(map({ deload_percent: 70, deload_weight: 55 }), "bench", NOW)).toEqual({
      percent: 70,
      weight: 55,
      until: "2026-11-01T00:00:00Z",
    });
  });
  it("old record without deload_percent uses default", () => {
    expect(activeLighterWeek(map(), "bench", NOW)).toMatchObject({ percent: DEFAULT_LIGHTER_PERCENT, weight: null });
  });
  it("percent bounds: 40 and 90 kept; 0, 100, 39, 91, fractions, NaN, strings fall back to default", () => {
    for (const p of [40, 90]) expect(activeLighterWeek(map({ deload_percent: p }), "bench", NOW)!.percent).toBe(p);
    for (const p of [0, 100, 39, 91, 55.5, Number.NaN, "70", null, -50, Infinity])
      expect(activeLighterWeek(map({ deload_percent: p }), "bench", NOW)!.percent).toBe(DEFAULT_LIGHTER_PERCENT);
  });
  it("expired or ending exactly now: null", () => {
    expect(activeLighterWeek(map({ until: "2026-10-26T12:00:00Z" }), "bench", NOW)).toBeNull();
    expect(activeLighterWeek(map({ until: "2026-10-25T00:00:00Z" }), "bench", NOW)).toBeNull();
    expect(activeLighterWeek(map({ until: "2026-10-26T12:00:00.001Z" }), "bench", NOW)).not.toBeNull();
  });
  it("not started yet: null; garbage applied_at ignored", () => {
    expect(activeLighterWeek(map({ applied_at: "2026-10-27T00:00:00Z" }), "bench", NOW)).toBeNull();
    expect(activeLighterWeek(map({ applied_at: "garbage" }), "bench", NOW)).not.toBeNull();
    const r = rec();
    delete (r as Record<string, unknown>).applied_at;
    expect(activeLighterWeek({ bench: r }, "bench", NOW)).not.toBeNull();
  });
  it("other exercise, other kind, malformed everything: null", () => {
    expect(activeLighterWeek(map(), "squat", NOW)).toBeNull();
    expect(activeLighterWeek(map({ kind: "swap" }), "bench", NOW)).toBeNull();
    expect(activeLighterWeek(map({ until: 123 }), "bench", NOW)).toBeNull();
    expect(activeLighterWeek(map({ until: "not a date" }), "bench", NOW)).toBeNull();
    for (const bad of [null, undefined, 5, "x", [], [rec()], { bench: null }, { bench: "deload" }, { bench: [] }])
      expect(activeLighterWeek(bad, "bench", NOW)).toBeNull();
  });
  it("prototype keys are not records", () => {
    expect(activeLighterWeek({}, "__proto__", NOW)).toBeNull();
    expect(activeLighterWeek({}, "constructor", NOW)).toBeNull();
    expect(activeLighterWeek({}, "toString", NOW)).toBeNull();
  });
  it("two lifts are independent", () => {
    const m = { ...map({ deload_percent: 50 }, "bench"), ...map({ until: "2026-10-01T00:00:00Z" }, "squat") };
    expect(activeLighterWeek(m, "bench", NOW)!.percent).toBe(50);
    expect(activeLighterWeek(m, "squat", NOW)).toBeNull();
  });
  it("bad saved weight ignored: 0, negative, NaN, over 1000, string", () => {
    for (const w of [0, -5, Number.NaN, 1001, "60", Infinity])
      expect(activeLighterWeek(map({ deload_weight: w }), "bench", NOW)!.weight).toBeNull();
    expect(activeLighterWeek(map({ deload_weight: 1000 }), "bench", NOW)!.weight).toBe(1000);
  });
});

describe("lighterWeekSuggestion QA", () => {
  const range = { min: 8, max: 12 };
  const lw = (o: Partial<LighterWeek> = {}): LighterWeek => ({ percent: 60, weight: null, until: "2026-11-01T00:00:00Z", ...o });
  const work = (n: number, reps: number, weight: number) => [...Array(n)].map(() => ({ reps, weight }));

  it("empty / warmup-only / zero-rep history: null", () => {
    expect(lighterWeekSuggestion([], range, "Barbell", lw())).toBeNull();
    expect(lighterWeekSuggestion([{ reps: 5, weight: 100, is_warmup: true }], range, "Barbell", lw())).toBeNull();
    expect(lighterWeekSuggestion([{ reps: 0, weight: 100 }], range, "Barbell", lw())).toBeNull();
  });
  it("warmups ignored when picking top weight", () => {
    const last = [{ reps: 5, weight: 200, is_warmup: true }, ...work(3, 10, 100)];
    expect(lighterWeekSuggestion(last, range, "Barbell", lw())).toMatchObject({ sets: 3, weight: 60 });
  });
  it("rounds to equipment step", () => {
    // 33 * 0.6 = 19.8 -> 20 (step 2.5)
    expect(lighterWeekSuggestion(work(3, 10, 33), range, "Barbell", lw())!.weight).toBe(20);
    // 41 * 0.6 = 24.6 -> 25
    expect(lighterWeekSuggestion(work(3, 10, 41), range, "Barbell", lw())!.weight).toBe(25);
  });
  it("percent 40 and 90 at limits stay at or below last weight", () => {
    for (const p of [40, 90]) {
      const r = lighterWeekSuggestion(work(3, 10, 100), range, "Barbell", lw({ percent: p }))!;
      expect(r.weight).toBe(p);
      expect(r.weight).toBeLessThanOrEqual(100);
    }
  });
  it("never heavier than last time even when saved weight is bigger", () => {
    expect(lighterWeekSuggestion(work(3, 10, 50), range, "Barbell", lw({ weight: 500 }))!.weight).toBe(50);
  });
  it("saved weight rounds to 2 decimals", () => {
    expect(lighterWeekSuggestion(work(3, 10, 100), range, "Barbell", lw({ weight: 57.3333 }))!.weight).toBe(57.33);
  });
  it("top-weight with all sets equal counts sets; mixed counts only top sets", () => {
    const last = [...work(2, 8, 100), ...work(3, 12, 80)];
    expect(lighterWeekSuggestion(last, range, "Barbell", lw())!.sets).toBe(2);
  });
  it("tiny weight does not round to zero", () => {
    const r = lighterWeekSuggestion(work(3, 10, 2), range, "Barbell", lw({ percent: 40 }))!;
    expect(r.weight).toBeGreaterThan(0);
    expect(r.weight).toBeLessThanOrEqual(2);
  });
  it("bodyweight stays at weight and reps drop, min 1; reps never exceed range min", () => {
    const r = lighterWeekSuggestion(work(3, 10, 0), range, "Body Only", lw({ percent: 90 }))!;
    expect(r.weight).toBe(0);
    expect(r.reps).toBeLessThanOrEqual(range.min);
    expect(r.reps).toBeGreaterThanOrEqual(1);
    expect(lighterWeekSuggestion(work(3, 10, 0), { min: 0, max: 0 }, "Body Only", lw())!.reps).toBe(1);
  });
  it("huge weights stay finite", () => {
    const r = lighterWeekSuggestion(work(1, 5, 1e9), range, "Barbell", lw())!;
    expect(Number.isFinite(r.weight)).toBe(true);
    expect(r.weight).toBeLessThanOrEqual(1e9);
  });
  it("does not mutate last", () => {
    const last = work(2, 10, 100);
    const snap = JSON.stringify(last);
    lighterWeekSuggestion(last, range, "Barbell", lw());
    expect(JSON.stringify(last)).toBe(snap);
  });
});

describe("recapSkipFields QA", () => {
  const c = (skipped: number, moved: number, topReasons: { reason: string; count: number }[] = []) => ({ skipped, moved, topReasons });

  it("zero skips: all zero, no reasons even if reasons given", () => {
    expect(recapSkipFields(c(0, 0, [{ reason: "tired", count: 4 }]))).toEqual({ skipped: 0, moved: 0, skip_reasons: {} });
  });
  it("only moved: reasons allowed up to moved", () => {
    expect(recapSkipFields(c(0, 2, [{ reason: "travel", count: 5 }]))).toEqual({ skipped: 0, moved: 2, skip_reasons: { travel: 2 } });
  });
  it("many reasons trimmed in order to the total", () => {
    const r = recapSkipFields(c(2, 1, [{ reason: "a", count: 2 }, { reason: "b", count: 2 }, { reason: "c", count: 2 }]));
    expect(r.skip_reasons).toEqual({ a: 2, b: 1 });
  });
  it("sum of reasons never exceeds skipped + moved (fuzz, fixed seed)", () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 300; i++) {
      const reasons = [...Array(Math.floor(rnd() * 8))].map(() => ({ reason: "r" + Math.floor(rnd() * 4), count: Math.floor(rnd() * 60) - 5 }));
      const r = recapSkipFields(c(Math.floor(rnd() * 50) - 3, Math.floor(rnd() * 50) - 3, reasons));
      const total = Object.values(r.skip_reasons).reduce<number>((a, b) => a + (b ?? 0), 0);
      expect(total).toBeLessThanOrEqual(r.skipped + r.moved);
      expect(r.skipped).toBeGreaterThanOrEqual(0);
      expect(r.skipped).toBeLessThanOrEqual(RECAP_MAX_DAYS_OFF);
      expect(r.moved).toBeLessThanOrEqual(RECAP_MAX_DAYS_OFF);
      for (const v of Object.values(r.skip_reasons)) {
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThanOrEqual(RECAP_MAX_DAYS_OFF);
      }
    }
  });
  it("period boundaries: 31 kept, 32 clamped, 28-day week fits", () => {
    expect(recapSkipFields(c(31, 0)).skipped).toBe(31);
    expect(recapSkipFields(c(32, 0)).skipped).toBe(31);
    expect(recapSkipFields(c(7, 0), 7).skipped).toBe(7);
    expect(recapSkipFields(c(8, 0), 7).skipped).toBe(7);
  });
  it("huge and non-finite counts", () => {
    expect(recapSkipFields(c(Number.MAX_SAFE_INTEGER, Infinity, [{ reason: "x", count: 1e12 }]))).toEqual({
      skipped: 31,
      moved: 0,
      skip_reasons: { x: 31 },
    });
    expect(recapSkipFields(c(-Infinity, Number.NaN))).toEqual({ skipped: 0, moved: 0, skip_reasons: {} });
  });
  it("reason merged across repeats and capped at max", () => {
    const r = recapSkipFields(c(31, 31, [{ reason: "a", count: 31 }, { reason: "a", count: 31 }]));
    expect(r.skip_reasons).toEqual({ a: 31 });
  });
  it("reason named like a prototype key is a normal key", () => {
    const r = recapSkipFields(c(2, 0, [{ reason: "constructor", count: 1 }, { reason: "__proto__", count: 1 }]));
    expect(Object.keys(r.skip_reasons).sort()).toContain("constructor");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((r.skip_reasons as Record<string, unknown>).constructor).toBe(1);
  });
  it("does not mutate input", () => {
    const input = c(2, 1, [{ reason: "a", count: 9 }]);
    const snap = JSON.stringify(input);
    recapSkipFields(input);
    expect(JSON.stringify(input)).toBe(snap);
  });
});
