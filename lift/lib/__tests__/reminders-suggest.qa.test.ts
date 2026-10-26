import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../offline/db";
import { DEFAULT_REMINDERS, getRecentWorkoutStarts, suggestedReminderTime, usualStartTime, type ReminderSettings } from "../reminders";

// Local wall-clock start, so results do not depend on the machine time zone.
const at = (day: number, h: number, m = 0, mon = 9, y = 2026) => new Date(y, mon, day, h, m).toISOString();
const same = (n: number, h: number, m = 0) => Array.from({ length: n }, (_, i) => at(1 + i, h, m));

describe("usualStartTime QA: count thresholds", () => {
  it("4 workouts -> null, 5 -> value", () => {
    expect(usualStartTime(same(4, 7, 15))).toBeNull();
    expect(usualStartTime(same(5, 7, 15))).toBe("07:15");
  });
  it("junk does not count toward the minimum", () => {
    const junk = ["", "nope", "2026-13-45T99:00:00Z", null, undefined, 5, {}] as unknown as string[];
    expect(usualStartTime([...same(4, 7), ...junk])).toBeNull();
    expect(usualStartTime([...same(5, 7), ...junk])).toBe("07:00");
  });
  it("empty input and huge input", () => {
    expect(usualStartTime([])).toBeNull();
    const big = Array.from({ length: 5000 }, (_, i) => at(1 + (i % 28), 6 + (i % 3), 0, i % 12));
    expect(usualStartTime(big)).toMatch(/^\d\d:\d\d$/);
  });
  it("only the newest 20 count (input order irrelevant)", () => {
    const newest = Array.from({ length: 20 }, (_, i) => at(1 + i, 18, 0, 9));
    const oldest = at(1, 5, 0, 0);
    expect(usualStartTime([oldest, ...newest])).toBe("18:00");
    expect(usualStartTime([...newest, oldest])).toBe("18:00");
    const old = Array.from({ length: 10 }, (_, i) => at(1 + i, 6, 0, 0));
    expect(usualStartTime([...old, ...newest])).toBe("18:00");
  });
  it("19 new + 1 old: old one is inside the window of 20 but median still new", () => {
    const newest = Array.from({ length: 19 }, (_, i) => at(1 + i, 18, 0, 9));
    expect(usualStartTime([...newest, at(1, 6, 0, 0)])).toBe("18:00");
  });
  it("min/recent options: recent below min is lifted to min; min 0 clamps to 1", () => {
    expect(usualStartTime(same(3, 8), { min: 3, recent: 1 })).toBe("08:00");
    expect(usualStartTime([at(1, 9)], { min: 0 })).toBe("09:00");
    expect(usualStartTime([], { min: 0 })).toBeNull();
  });
});

describe("usualStartTime QA: median and rounding", () => {
  it("even count averages middle two", () => {
    expect(usualStartTime([at(1, 6), at(2, 6), at(3, 7), at(4, 8), at(5, 8), at(6, 9)])).toBe("07:30");
  });
  it("half minute rounds up", () => {
    expect(usualStartTime([at(1, 5), at(2, 6), at(3, 7, 0), at(4, 7, 1), at(5, 9), at(6, 10)])).toBe("07:01");
  });
  it("seconds are truncated, not rounded", () => {
    const d = new Date(2026, 9, 1, 7, 0, 59).toISOString();
    expect(usualStartTime([d, d, d, d, d])).toBe("07:00");
  });
  it("order independent (fixed-seed shuffle)", () => {
    let s = 12345;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const base = Array.from({ length: 15 }, (_, i) => at(1 + i, 6 + Math.floor(rnd() * 12), Math.floor(rnd() * 60)));
    const expected = usualStartTime(base);
    for (let k = 0; k < 20; k++) {
      const sh = [...base].sort(() => rnd() - 0.5);
      expect(usualStartTime(sh)).toBe(expected);
    }
  });
  it("fuzz: always valid HH:MM, never throws", () => {
    let s = 99;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let k = 0; k < 200; k++) {
      const n = Math.floor(rnd() * 30);
      const arr = Array.from({ length: n }, () => at(1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24), Math.floor(rnd() * 60), Math.floor(rnd() * 12)));
      const out = usualStartTime(arr);
      if (out !== null) expect(out).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    }
  });
});

describe("usualStartTime QA: dates", () => {
  it("DST boundaries: same wall time across spring/autumn changes stays the same", () => {
    const dates = [at(1, 18, 0, 2), at(15, 18, 0, 2), at(28, 18, 0, 2), at(5, 18, 0, 3), at(25, 18, 0, 9), at(1, 18, 0, 10), at(30, 18, 0, 9)];
    expect(usualStartTime(dates)).toBe("18:00");
  });
  it("future dates do not crash and are treated as ordinary starts", () => {
    expect(usualStartTime(Array.from({ length: 5 }, (_, i) => at(1 + i, 7, 0, 5, 2099)))).toBe("07:00");
  });
  it("3x 23:50 and 3x 00:10 does not average to midday (midnight wrap)", () => {
    const iso = [at(1, 23, 50), at(2, 23, 50), at(3, 23, 50), at(4, 0, 10), at(5, 0, 10), at(6, 0, 10)];
    const out = usualStartTime(iso)!;
    const mins = Number(out.slice(0, 2)) * 60 + Number(out.slice(3));
    expect(Math.min(mins, 1440 - mins)).toBeLessThanOrEqual(60);
  });
  it("3x 23:50 and 2x 00:10 stays near midnight", () => {
    const out = usualStartTime([at(1, 23, 50), at(2, 23, 50), at(3, 23, 50), at(4, 0, 10), at(5, 0, 10)])!;
    expect(["23:50", "00:00", "00:10"]).toContain(out);
  });
  it("23:59 median stays 23:59 (no 24:00)", () => {
    expect(usualStartTime(same(5, 23, 59))).toBe("23:59");
  });
  it("exactly midnight", () => {
    expect(usualStartTime(same(5, 0, 0))).toBe("00:00");
  });
});

describe("suggestedReminderTime QA", () => {
  const r = (o: Partial<ReminderSettings> = {}): ReminderSettings => ({ ...DEFAULT_REMINDERS, ...o });
  it("never mutates settings or the input array", () => {
    const settings = r({ days: [1, 3], time: "18:00" });
    const snapshot = JSON.stringify(settings);
    const starts = same(6, 7);
    const startsSnap = [...starts];
    suggestedReminderTime(settings, starts);
    expect(JSON.stringify(settings)).toBe(snapshot);
    expect(starts).toEqual(startsSnap);
    const frozen = Object.freeze(r());
    expect(() => suggestedReminderTime(frozen, Object.freeze(same(5, 7)) as readonly string[])).not.toThrow();
  });
  it("4 workouts -> null, 5 -> suggestion", () => {
    expect(suggestedReminderTime(r(), same(4, 7))).toBeNull();
    expect(suggestedReminderTime(r(), same(5, 7))).toBe("07:00");
  });
  it("null once saved time equals usual; back if time differs by 1 minute", () => {
    expect(suggestedReminderTime(r({ time: "07:00" }), same(5, 7))).toBeNull();
    expect(suggestedReminderTime(r({ time: "07:01" }), same(5, 7))).toBe("07:00");
  });
  it("independent of smart switch, days and skip", () => {
    expect(suggestedReminderTime(r({ smart: true, days: [] }), same(5, 7))).toBe("07:00");
    expect(suggestedReminderTime(r({ smart: false, skipDate: "2026-10-26" }), same(5, 7))).toBe("07:00");
  });
});

describe("getRecentWorkoutStarts QA", () => {
  const w = (id: string, started_at: string) => ({ id, started_at, ended_at: null, notes: null, routine_id: null });
  beforeEach(async () => {
    await db.workouts.clear();
  });
  it("default window is 20, newest first, from 25 rows", async () => {
    await db.workouts.bulkAdd(Array.from({ length: 25 }, (_, i) => w(`w${i}`, new Date(Date.UTC(2026, 8, 1 + i, 12)).toISOString())));
    const out = await getRecentWorkoutStarts();
    expect(out).toHaveLength(20);
    expect(out[0]).toBe(new Date(Date.UTC(2026, 8, 25, 12)).toISOString());
    expect(out[19]).toBe(new Date(Date.UTC(2026, 8, 6, 12)).toISOString());
  });
  it("limit 1", async () => {
    await db.workouts.bulkAdd([w("a", "2026-10-01T10:00:00.000Z"), w("b", "2026-10-02T10:00:00.000Z")]);
    expect(await getRecentWorkoutStarts(1)).toEqual(["2026-10-02T10:00:00.000Z"]);
  });
  it("workouts with null routine and unfinished still count", async () => {
    await db.workouts.bulkAdd(Array.from({ length: 5 }, (_, i) => w(`n${i}`, at(1 + i, 8))));
    expect(usualStartTime(await getRecentWorkoutStarts())).toBe("08:00");
  });
});
