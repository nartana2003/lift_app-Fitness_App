import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/offline/db";
import {
  DEFAULT_REMINDERS,
  getMarkedGymDates,
  localDateKey,
  nextReminder,
  normalizeReminders,
  type ReminderSettings,
} from "@/lib/reminders";

const base = (o: Partial<ReminderSettings> = {}): ReminderSettings => ({ ...DEFAULT_REMINDERS, ...o });
const at = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0);

// Deterministic PRNG (mulberry32)
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("nextReminder with marked dates (QA)", () => {
  it("is exactly the old result when dates is undefined, [] or only junk (fuzz)", () => {
    const r = rng(42);
    for (let i = 0; i < 300; i++) {
      const days = [0, 1, 2, 3, 4, 5, 6].filter(() => r() < 0.4);
      const now = at(2026, 10, 1 + Math.floor(r() * 28), Math.floor(r() * 24), Math.floor(r() * 60));
      const s = base({ days, time: "18:00", skipDate: r() < 0.3 ? localDateKey(now) : null });
      const a = nextReminder(s, now);
      expect(nextReminder(s, now, [])?.getTime()).toBe(a?.getTime());
      expect(nextReminder(s, now, ["nope", "2026-02-30", "", "2026-13-01"])?.getTime()).toBe(a?.getTime());
    }
  });

  it("invariants hold for random dates, weekdays, skip and snooze (fuzz)", () => {
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const now = at(2026, 10, 1 + Math.floor(r() * 28), Math.floor(r() * 24), Math.floor(r() * 60));
      const days = [0, 1, 2, 3, 4, 5, 6].filter(() => r() < 0.2);
      const dates = Array.from({ length: Math.floor(r() * 5) }, () => localDateKey(at(2026, 10, 1 + Math.floor(r() * 60))));
      const snooze = r() < 0.3 ? new Date(now.getTime() + Math.floor(r() * 5 * 3600_000) - 1800_000).toISOString() : null;
      const skipDate = r() < 0.3 ? localDateKey(at(2026, 10, 1 + Math.floor(r() * 60))) : null;
      const s = base({ days, time: "07:30", snoozedUntil: snooze, skipDate });
      const out = nextReminder(s, now, dates);
      const without = nextReminder(s, now);
      if (out) {
        expect(out.getTime()).toBeGreaterThan(now.getTime());
        // Adding dates can only bring the reminder earlier, never later.
        if (without) expect(out.getTime()).toBeLessThanOrEqual(without.getTime());
        const isSnooze = snooze && out.getTime() === new Date(snooze).getTime();
        if (!isSnooze) {
          expect(localDateKey(out)).not.toBe(skipDate);
          expect(out.getHours() * 60 + out.getMinutes()).toBe(7 * 60 + 30);
        }
      } else {
        expect(without).toBeNull();
      }
    }
  });

  it("single marked date today at the exact reminder minute is not 'ahead' (strictly after now)", () => {
    const now = at(2026, 10, 26, 18, 0);
    expect(nextReminder(base(), now, ["2026-10-26"])).toBeNull();
    expect(nextReminder(base(), at(2026, 10, 26, 17, 59), ["2026-10-26"])?.getTime()).toBe(now.getTime());
  });

  it("marked date today that is skipped, with a later marked date, goes to the later date", () => {
    const now = at(2026, 10, 26, 9);
    const out = nextReminder(base({ skipDate: "2026-10-26" }), now, ["2026-10-26", "2026-10-29"]);
    expect(out).toEqual(at(2026, 10, 29, 18));
  });

  it("skipped marked date with no other date gives null", () => {
    expect(nextReminder(base({ skipDate: "2026-10-27" }), at(2026, 10, 26, 9), ["2026-10-27"])).toBeNull();
  });

  it("snooze shorter than the next marked date wins; a snooze after it on the same day wins too", () => {
    const now = at(2026, 10, 26, 9);
    const soon = new Date(now.getTime() + 30 * 60_000);
    expect(nextReminder(base({ snoozedUntil: soon.toISOString() }), now, ["2026-10-26"])).toEqual(soon);
    const late = at(2026, 10, 26, 20);
    expect(nextReminder(base({ snoozedUntil: late.toISOString() }), now, ["2026-10-26"])).toEqual(late);
  });

  it("an expired snooze is ignored", () => {
    const now = at(2026, 10, 26, 9);
    const old = new Date(now.getTime() - 60_000).toISOString();
    expect(nextReminder(base({ snoozedUntil: old }), now, ["2026-10-28"])).toEqual(at(2026, 10, 28, 18));
  });

  it("duplicates, huge lists and year-end rollover work", () => {
    const now = at(2026, 12, 31, 20);
    const many = Array.from({ length: 5000 }, (_, i) => localDateKey(at(2026, 1, 1 + (i % 400))));
    expect(nextReminder(base(), now, many)).toEqual(at(2027, 1, 1, 18) > now ? at(2027, 1, 1, 18) : null);
    expect(nextReminder(base(), now, ["2027-01-01", "2027-01-01"])).toEqual(at(2027, 1, 1, 18));
  });

  it("leap day is accepted, non-leap Feb 29 rejected", () => {
    expect(nextReminder(base(), at(2028, 2, 28, 20), ["2028-02-29"])).toEqual(at(2028, 2, 29, 18));
    expect(nextReminder(base(), at(2027, 2, 27, 20), ["2027-02-29"])).toBeNull();
  });

  it("does not mutate its inputs and an invalid stored time still returns null", () => {
    const dates = ["2026-10-29", "2026-10-27"];
    const copy = [...dates];
    const s = base({ days: [3] });
    const snap = JSON.stringify(s);
    nextReminder(s, at(2026, 10, 26, 9), dates);
    expect(dates).toEqual(copy);
    expect(JSON.stringify(s)).toBe(snap);
    expect(nextReminder({ ...s, time: "25:99" }, at(2026, 10, 26, 9), dates)).toBeNull();
  });

  it("normalizeReminders keeps the stored shape (no new keys)", () => {
    expect(Object.keys(normalizeReminders({ days: [1], gymDates: ["2026-10-27"] })).sort()).toEqual(
      Object.keys(DEFAULT_REMINDERS).sort(),
    );
  });
});

describe("getMarkedGymDates (QA)", () => {
  beforeEach(async () => {
    await db.planned_days.clear();
  });
  const row = (id: string, date: string, status: "planned" | "done" | "skipped" | "moved") => ({
    id, date, status, routine_id: null, workout_id: null, skip_reason: null, skip_note: null,
  }) as never;

  it("includes planned rows with a null routine, excludes past and non-planned, sorted", async () => {
    await db.planned_days.bulkPut([
      row("a", "2026-10-30", "planned"),
      row("b", "2026-10-26", "planned"),
      row("c", "2026-10-25", "planned"),
      row("d", "2026-10-27", "done"),
      row("e", "2026-10-28", "skipped"),
      row("f", "2026-10-29", "moved"),
    ]);
    expect(await getMarkedGymDates("2026-10-26")).toEqual(["2026-10-26", "2026-10-30"]);
  });

  it("unmarking (delete) removes the date; end-to-end with nextReminder", async () => {
    await db.planned_days.put(row("a", "2026-10-28", "planned"));
    const now = at(2026, 10, 26, 9);
    expect(nextReminder(base(), now, await getMarkedGymDates("2026-10-26"))).toEqual(at(2026, 10, 28, 18));
    await db.planned_days.delete("a");
    expect(nextReminder(base(), now, await getMarkedGymDates("2026-10-26"))).toBeNull();
  });
});
