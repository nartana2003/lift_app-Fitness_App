import { describe, expect, it } from "vitest";
import realCatalogue from "../../data/exercises.json";
import { RECAP_MAX_DAYS_OFF, recapSkipFields, type PeriodStats, type SkipCounts } from "../stats";
import { skipStats, type PlannedDayLite } from "../progress";
import { MAX_DAYS_OFF, buildContext, promptData, ruleRecap, validateInput } from "../ai/summary";
import type { Exercise } from "../exercises";
import { buildSummaryBody, toBaseStats } from "../../components/progress/RecapCard";

const CAT = realCatalogue as unknown as Exercise[];
const BY_ID = new Map(CAT.map((e) => [e.id, e]));

const counts = (skipped: number, moved: number, topReasons: SkipCounts["topReasons"] = []): SkipCounts => ({ skipped, moved, topReasons });

const stats = (over: Partial<PeriodStats> = {}): PeriodStats => ({
  sessions: 2,
  duration_sec: 7200,
  volume: 5400,
  sets_by_muscle: { Chest: 6 },
  workout_days: [],
  ...over,
});

const day = (date: string, status: PlannedDayLite["status"], skip_reason: PlannedDayLite["skip_reason"] = null): PlannedDayLite => ({
  date,
  status,
  skip_reason,
});

// Week of Mon 12 Oct 2026.
const FROM = new Date(2026, 9, 12);
const TO = new Date(2026, 9, 19);
const PLAN: PlannedDayLite[] = [
  day("2026-10-12", "done"),
  day("2026-10-13", "skipped", "tired"),
  day("2026-10-14", "skipped", "tired"),
  day("2026-10-15", "moved", "travel"),
  day("2026-10-16", "skipped", null),
  day("2026-10-17", "planned"),
  day("2026-10-08", "skipped", "sick"), // previous week
];

describe("recapSkipFields", () => {
  it("keeps the counts and turns reasons into a map", () => {
    expect(recapSkipFields(counts(2, 1, [{ reason: "tired", count: 2 }, { reason: "travel", count: 1 }]))).toEqual({
      skipped: 2,
      moved: 1,
      skip_reasons: { tired: 2, travel: 1 },
    });
  });

  it("gives zeros and no reasons for a clean period", () => {
    expect(recapSkipFields(counts(0, 0))).toEqual({ skipped: 0, moved: 0, skip_reasons: {} });
  });

  it("clamps counts to whole numbers in [0, max]", () => {
    expect(recapSkipFields(counts(40, -2))).toEqual({ skipped: RECAP_MAX_DAYS_OFF, moved: 0, skip_reasons: {} });
    expect(recapSkipFields(counts(2.7, Number.NaN))).toEqual({ skipped: 2, moved: 0, skip_reasons: {} });
    expect(recapSkipFields(counts(5, 5), 3)).toEqual({ skipped: 3, moved: 3, skip_reasons: {} });
  });

  it("never lets reasons total more than skipped + moved", () => {
    const r = recapSkipFields(counts(2, 0, [{ reason: "busy", count: 2 }, { reason: "sore", count: 3 }]));
    expect(r.skip_reasons).toEqual({ busy: 2 });
    const r2 = recapSkipFields(counts(3, 0, [{ reason: "busy", count: 2 }, { reason: "sore", count: 3 }]));
    expect(r2.skip_reasons).toEqual({ busy: 2, sore: 1 });
  });

  it("merges a repeated reason and drops zero or negative counts", () => {
    const r = recapSkipFields(counts(5, 0, [{ reason: "busy", count: 1 }, { reason: "rest", count: 0 }, { reason: "busy", count: 2 }, { reason: "sick", count: -1 }]));
    expect(r.skip_reasons).toEqual({ busy: 3 });
  });

  it("uses the route's cap by default", () => {
    expect(RECAP_MAX_DAYS_OFF).toBe(MAX_DAYS_OFF);
  });
});

describe("weekly/monthly recap body with skip stats", () => {
  const cur = skipStats(PLAN, FROM, TO, 8);
  const prev = skipStats(PLAN, new Date(2026, 9, 5), FROM, 0);

  it("toBaseStats is unchanged without skips and uses them when given", () => {
    expect(toBaseStats(stats())).toMatchObject({ skipped: 0, moved: 0 });
    expect(toBaseStats(stats(), cur)).toMatchObject({ skipped: 3, moved: 1 });
    expect(toBaseStats(stats(), null)).toMatchObject({ skipped: 0, moved: 0 });
  });

  it("buildSummaryBody without skips sends what it always sent", () => {
    const b = buildSummaryBody("week", "kg", stats(), stats({ sessions: 1 }), []);
    expect(b.current).toEqual({ sessions: 2, duration_sec: 7200, volume: 5400, sets_by_muscle: { Chest: 6 }, skipped: 0, moved: 0 });
    expect(b.previous).toMatchObject({ skipped: 0, moved: 0 });
  });

  it("sends this period's skipped, moved and reasons, and last period's counts", () => {
    const b = buildSummaryBody("week", "kg", stats(), stats({ sessions: 1 }), [], cur, prev);
    expect(b.current).toMatchObject({ skipped: 3, moved: 1, skip_reasons: { tired: 2, travel: 1 } });
    expect(b.previous).toMatchObject({ skipped: 1, moved: 0 });
    expect(b.previous).not.toHaveProperty("skip_reasons");
  });

  it("leaves skip_reasons out when no day had a reason", () => {
    const b = buildSummaryBody("month", "kg", stats(), null, [], skipStats([day("2026-10-13", "skipped")], FROM, TO));
    expect(b.current).toMatchObject({ skipped: 1, moved: 0 });
    expect(b.current).not.toHaveProperty("skip_reasons");
  });

  it("the route accepts the body and the recap context carries the skip stats", () => {
    const body = buildSummaryBody("week", "kg", stats(), stats({ sessions: 1 }), [], cur, prev);
    const r = validateInput(JSON.parse(JSON.stringify(body)), BY_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ctx = buildContext(r.input, CAT);
    const data = promptData(ctx);
    expect(data.current).toMatchObject({ skipped: 3, moved: 1, skip_reasons: { tired: 2, travel: 1 } });
    expect(data.previous).toMatchObject({ skipped: 1, moved: 0 });
    // The rule-based recap (no key) mentions them too.
    expect(ruleRecap(ctx).join(" ")).toMatch(/4 planned days changed \(3 skipped, 1 moved\), mostly tired/);
  });

  it("the route still accepts the body when counts hit the cap", () => {
    const many = counts(50, 50, [{ reason: "busy", count: 60 }, { reason: "rest", count: 40 }]);
    const body = buildSummaryBody("month", "kg", stats(), stats(), [], many, many);
    expect(validateInput(JSON.parse(JSON.stringify(body)), BY_ID).ok).toBe(true);
  });
});
