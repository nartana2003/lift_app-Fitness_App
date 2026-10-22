import { describe, expect, it } from "vitest";
import { skipStats, type PlannedDayLite } from "../progress";
import type { SkipReason } from "../offline/db";

const day = (date: string, status: PlannedDayLite["status"], skip_reason: SkipReason | null = null): PlannedDayLite => ({
  date,
  status,
  skip_reason,
});

// Week of Mon 12 Oct 2026 (local).
const FROM = new Date(2026, 9, 12);
const TO = new Date(2026, 9, 19);

describe("skipStats", () => {
  it("is all zeros with no planned days", () => {
    expect(skipStats([], FROM, TO)).toEqual({ skipped: 0, moved: 0, topReasons: [] });
  });

  it("counts skipped and moved days separately and ignores planned and done days", () => {
    const days = [
      day("2026-10-12", "skipped", "busy"),
      day("2026-10-13", "moved", "tired"),
      day("2026-10-15", "planned"), // where the moved day landed: not counted
      day("2026-10-14", "done"),
      day("2026-10-16", "skipped", "busy"),
    ];
    const s = skipStats(days, FROM, TO);
    expect(s.skipped).toBe(2);
    expect(s.moved).toBe(1);
    expect(s.topReasons).toEqual([
      { reason: "busy", count: 2 },
      { reason: "tired", count: 1 },
    ]);
  });

  it("only counts days in [from, to)", () => {
    const days = [
      day("2026-10-11", "skipped", "sick"), // Sunday before
      day("2026-10-12", "skipped", "sore"), // first day, included
      day("2026-10-18", "moved", "travel"), // last day, included
      day("2026-10-19", "skipped", "sick"), // next Monday, excluded
    ];
    const s = skipStats(days, FROM, TO);
    expect(s).toEqual({
      skipped: 1,
      moved: 1,
      topReasons: [
        { reason: "sore", count: 1 },
        { reason: "travel", count: 1 },
      ],
    });
  });

  it("works for a month range", () => {
    const days = [day("2026-10-01", "skipped", "rest"), day("2026-10-31", "skipped", "rest"), day("2026-11-01", "skipped", "rest")];
    const s = skipStats(days, new Date(2026, 9, 1), new Date(2026, 10, 1));
    expect(s.skipped).toBe(2);
    expect(s.topReasons).toEqual([{ reason: "rest", count: 2 }]);
  });

  it("sorts reasons by count, breaks ties in the app's reason order, and caps at the limit", () => {
    const days = [
      day("2026-10-12", "skipped", "other"),
      day("2026-10-12", "skipped", "injury"),
      day("2026-10-13", "skipped", "sick"),
      day("2026-10-14", "moved", "sick"),
      day("2026-10-15", "skipped", "travel"),
    ];
    expect(skipStats(days, FROM, TO).topReasons).toEqual([
      { reason: "sick", count: 2 },
      { reason: "injury", count: 1 },
      { reason: "travel", count: 1 },
    ]);
    expect(skipStats(days, FROM, TO, 1).topReasons).toEqual([{ reason: "sick", count: 2 }]);
    expect(skipStats(days, FROM, TO, 0).topReasons).toEqual([]);
  });

  it("counts a skip with no reason but leaves it out of the reasons", () => {
    const s = skipStats([day("2026-10-13", "skipped", null)], FROM, TO);
    expect(s.skipped).toBe(1);
    expect(s.topReasons).toEqual([]);
  });
});
