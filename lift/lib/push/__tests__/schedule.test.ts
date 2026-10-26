import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { localParts, normalizeServerReminder, reminderDue, reminderPayload, safeTimeZone, shiftDate, zonedInstant } from "../schedule";
import { DEFAULT_REMINDERS, nextReminder, normalizeReminders, type ReminderSettings } from "../../reminders";

const settings = (o: Partial<ReminderSettings> = {}): ReminderSettings => ({ ...DEFAULT_REMINDERS, ...o });

describe("helpers", () => {
  it("safeTimeZone falls back to UTC", () => {
    expect(safeTimeZone("Europe/London")).toBe("Europe/London");
    expect(safeTimeZone("Mars/Base")).toBe("UTC");
    expect(safeTimeZone(5)).toBe("UTC");
  });

  it("localParts reads the wall clock in the zone", () => {
    // 2026-10-26 (Monday) 23:30 UTC = Tuesday 08:30 in Tokyo, Monday 19:30 in New York (EDT).
    const t = new Date("2026-10-26T23:30:00Z");
    expect(localParts(t, "UTC")).toEqual({ date: "2026-10-26", weekday: 1, minutes: 23 * 60 + 30 });
    expect(localParts(t, "Asia/Tokyo")).toEqual({ date: "2026-10-27", weekday: 2, minutes: 8 * 60 + 30 });
    expect(localParts(t, "America/New_York")).toEqual({ date: "2026-10-26", weekday: 1, minutes: 19 * 60 + 30 });
    expect(localParts(new Date("2026-10-26T00:05:00Z"), "UTC").minutes).toBe(5);
  });

  it("shiftDate crosses months and years", () => {
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("normalizeServerReminder matches normalizeReminders on the shared fields", () => {
    const inputs: unknown[] = [
      null,
      "x",
      [],
      { days: [5, 1, 1, 9, -1, 2.5, "3"], time: "06:15", skipDate: "2026-10-26", snoozedUntil: "2026-10-26T10:00:00Z" },
      { days: "1", time: "25:00", skipDate: "26/10/2026", snoozedUntil: "soon" },
      { days: [0, 6], time: "7:00" },
    ];
    for (const raw of inputs) {
      const a = normalizeReminders(raw);
      expect(normalizeServerReminder(raw)).toEqual({ days: a.days, time: a.time, skipDate: a.skipDate, snoozedUntil: a.snoozedUntil });
    }
  });
});

describe("reminderDue (UTC)", () => {
  const at = (iso: string) => new Date(iso);
  const MON = "2026-10-26";

  it("fires in the window after the reminder time on a usual weekday", () => {
    const r = settings({ days: [1], time: "18:00" });
    expect(reminderDue(r, [], at(`${MON}T18:00:00Z`), "UTC")).toEqual({ kind: "gym", date: MON });
    expect(reminderDue(r, [], at(`${MON}T18:59:00Z`), "UTC")).toEqual({ kind: "gym", date: MON });
    expect(reminderDue(r, [], at(`${MON}T17:59:00Z`), "UTC")).toBeNull();
    expect(reminderDue(r, [], at(`${MON}T19:00:00Z`), "UTC")).toBeNull();
    expect(reminderDue(r, [], at("2026-10-27T18:30:00Z"), "UTC")).toBeNull();
  });

  it("fires on a marked date and across midnight", () => {
    const r = settings({ days: [], time: "23:30" });
    expect(reminderDue(r, ["2026-10-28"], at("2026-10-28T23:45:00Z"), "UTC")).toEqual({ kind: "gym", date: "2026-10-28" });
    expect(reminderDue(r, ["2026-10-28"], at("2026-10-29T00:10:00Z"), "UTC")).toEqual({ kind: "gym", date: "2026-10-28" });
    expect(reminderDue(r, ["2026-10-28"], at("2026-10-29T00:40:00Z"), "UTC")).toBeNull();
    expect(reminderDue(r, ["bad", 5 as unknown as string], at("2026-10-28T23:45:00Z"), "UTC")).toBeNull();
  });

  it("uses the user's time zone", () => {
    const r = settings({ days: [2], time: "08:00" }); // Tuesday 08:00 in Tokyo = Monday 23:00 UTC
    expect(reminderDue(r, [], at(`${MON}T23:10:00Z`), "Asia/Tokyo")).toEqual({ kind: "gym", date: "2026-10-27" });
    expect(reminderDue(r, [], at(`${MON}T23:10:00Z`), "UTC")).toBeNull();
  });

  it("skips the skipped date", () => {
    const r = settings({ days: [1], time: "18:00", skipDate: MON });
    expect(reminderDue(r, [], at(`${MON}T18:10:00Z`), "UTC")).toBeNull();
  });

  it("a snooze replaces the day's earlier reminder and fires when it ends", () => {
    const r = settings({ days: [1], time: "18:00", snoozedUntil: `${MON}T18:30:00Z` });
    expect(reminderDue(r, [], at(`${MON}T18:10:00Z`), "UTC", 15)).toBeNull();
    expect(reminderDue(r, [], at(`${MON}T18:40:00Z`), "UTC", 15)).toEqual({ kind: "snooze" });
    // Snooze on a skipped day never fires.
    expect(reminderDue({ ...r, skipDate: MON }, [], at(`${MON}T18:40:00Z`), "UTC", 15)).toBeNull();
  });

  it("garbage settings never fire", () => {
    expect(reminderDue(null, [], at(`${MON}T18:00:00Z`), "UTC")).toBeNull();
    expect(reminderDue({ days: "all" }, [], at(`${MON}T18:00:00Z`), "Nowhere/Zone")).toBeNull();
  });
});

describe("agrees with nextReminder (lib/reminders.ts) in this machine's zone", () => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cases: { r: ReminderSettings; dates: string[] }[] = [
    { r: settings({ days: [1, 3, 5], time: "18:00" }), dates: [] },
    { r: settings({ days: [], time: "07:30" }), dates: ["2026-10-28", "2026-10-31"] },
    { r: settings({ days: [2], time: "00:00", skipDate: "2026-10-27" }), dates: ["2026-10-29"] },
    { r: settings({ days: [1, 2], time: "06:45", snoozedUntil: "2026-10-27T03:00:00.000Z" }), dates: [] },
  ];

  it("fires exactly at each next reminder and never between", () => {
    const start = new Date("2026-10-26T00:00:00Z");
    for (const { r, dates } of cases) {
      let t = start;
      for (let i = 0; i < 4; i++) {
        const next = nextReminder(r, t, dates);
        if (!next) break;
        expect(reminderDue(r, dates, next, tz, 1), `${JSON.stringify(r)} at ${next.toISOString()}`).not.toBeNull();
        for (let m = t.getTime() + 60_000; m < next.getTime(); m += 7 * 60_000) {
          expect(reminderDue(r, dates, new Date(m), tz, 1), `${JSON.stringify(r)} early at ${new Date(m).toISOString()}`).toBeNull();
        }
        t = next;
      }
    }
  });
});

describe("reminderPayload", () => {
  it("plain text, no emojis, per-day tag", () => {
    const p = reminderPayload({ kind: "gym", date: "2026-10-26" });
    expect(p).toMatchObject({ title: "Lift", url: "/", tag: "lift-reminder-2026-10-26", kind: "reminder" });
    expect(/\p{Extended_Pictographic}/u.test(p.body)).toBe(false);
    expect(reminderPayload({ kind: "snooze" }).body).toMatch(/Snooze/);
  });
});

describe("zonedInstant (resolved like new Date(y, m, d, hh, mm))", () => {
  const NY = "America/New_York";
  it("ordinary days", () => {
    expect(new Date(zonedInstant("2026-10-26", 18 * 60, "UTC")).toISOString()).toBe("2026-10-26T18:00:00.000Z");
    expect(new Date(zonedInstant("2026-10-26", 18 * 60, NY)).toISOString()).toBe("2026-10-26T22:00:00.000Z");
    expect(new Date(zonedInstant("2026-10-27", 8 * 60, "Asia/Tokyo")).toISOString()).toBe("2026-10-26T23:00:00.000Z");
  });
  it("fall back: the earlier of the two 01:30s", () => {
    expect(new Date(zonedInstant("2026-11-01", 90, NY)).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
  it("spring forward: 02:30 does not exist and becomes 03:30", () => {
    expect(new Date(zonedInstant("2026-03-08", 150, NY)).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
});
