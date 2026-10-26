import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { localParts, normalizeServerReminder, reminderDue, reminderPayload, safeTimeZone, shiftDate } from "../schedule";
import { DEFAULT_REMINDERS, nextReminder, toggleSkipToday, toggleSnooze, localDateKey, type ReminderSettings } from "../../reminders";

const settings = (o: Partial<ReminderSettings> = {}): ReminderSettings => ({ ...DEFAULT_REMINDERS, ...o });
const at = (iso: string) => new Date(iso);
const MIN = 60_000;

describe("reminderDue invalid input", () => {
  it("bad zone strings fall back to UTC and never throw", () => {
    for (const tz of ["", "x", "UTC+5", "Mars/Base", "a".repeat(100), null, undefined, 5, {}, "America/New_York\u0000"]) {
      expect(() => reminderDue(settings({ days: [1], time: "18:00" }), [], at("2026-10-26T18:10:00Z"), tz as string)).not.toThrow();
    }
    expect(reminderDue(settings({ days: [1], time: "18:00" }), [], at("2026-10-26T18:10:00Z"), "Mars/Base")).toEqual({ kind: "gym", date: "2026-10-26" });
    expect(safeTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });
  it("junk days/time/skip/snooze are normalised, not trusted", () => {
    const n = normalizeServerReminder({ days: [7, -1, 1.5, NaN, "1", null, 3, 3], time: "24:00", skipDate: "tomorrow", snoozedUntil: "nope" });
    expect(n).toEqual({ days: [3], time: "18:00", skipDate: null, snoozedUntil: null });
    expect(normalizeServerReminder(undefined).days).toEqual([]);
  });
  it("non-positive window never fires", () => {
    const r = settings({ days: [1], time: "18:00" });
    expect(reminderDue(r, [], at("2026-10-26T18:00:00Z"), "UTC", 0)).toBeNull();
    expect(reminderDue(r, [], at("2026-10-26T18:00:00Z"), "UTC", -5)).toBeNull();
  });
  it("gym dates with junk / far dates are ignored", () => {
    const r = settings({ days: [], time: "18:00" });
    expect(reminderDue(r, ["2026-02-30", "", "2026-10-2", "2026-10-26 "], at("2026-10-26T18:10:00Z"), "UTC")).toBeNull();
    expect(reminderDue(r, ["2026-10-26"], at("2026-10-26T18:10:00Z"), "UTC")).toEqual({ kind: "gym", date: "2026-10-26" });
  });
  it("empty days and no marked dates: never due for a whole week of minutes", () => {
    const r = settings({ days: [], time: "18:00" });
    for (let m = 0; m < 7 * 1440; m += 17) expect(reminderDue(r, [], new Date(at("2026-10-26T00:00:00Z").getTime() + m * MIN), "UTC")).toBeNull();
  });
});

describe("hourly cron fires each reminder exactly once", () => {
  const zones = ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland", "Asia/Kathmandu", "Europe/London"];
  const times = ["00:00", "06:30", "23:59"];
  for (const tz of zones) {
    it(`${tz}: every day gets exactly one gym push across cron offsets`, () => {
      for (const time of times) {
        for (const offset of [0, 37]) {
          const r = settings({ days: [0, 1, 2, 3, 4, 5, 6], time });
          const start = at("2026-10-12T00:00:00Z").getTime() + offset * MIN;
          const fired: string[] = [];
          for (let h = 0; h < 24 * 6; h++) {
            const d = reminderDue(r, [], new Date(start + h * 60 * MIN), tz);
            if (d?.kind === "gym") fired.push(d.date);
          }
          // 6 days of ticks: no duplicates, and consecutive days only.
          expect(new Set(fired).size, `${tz} ${time} +${offset}`).toBe(fired.length);
          expect(fired.length).toBeGreaterThanOrEqual(5);
        }
      }
    });
  }
  it("a reminder at the end of the window boundary fires once, not twice", () => {
    const r = settings({ days: [1], time: "18:00" });
    expect(reminderDue(r, [], at("2026-10-26T18:00:00Z"), "UTC")).not.toBeNull();
    expect(reminderDue(r, [], at("2026-10-26T19:00:00Z"), "UTC")).toBeNull();
  });
});

describe("midnight and day edges", () => {
  it("00:00 reminder belongs to the new day; tick at 00:30 fires it", () => {
    const r = settings({ days: [2], time: "00:00" });
    expect(reminderDue(r, [], at("2026-10-27T00:30:00Z"), "UTC")).toEqual({ kind: "gym", date: "2026-10-27" });
    expect(reminderDue(r, [], at("2026-10-26T23:30:00Z"), "UTC")).toBeNull();
  });
  it("23:30 reminder with a tick after midnight uses yesterday's weekday and skip date", () => {
    const r = settings({ days: [1], time: "23:30" });
    expect(reminderDue(r, [], at("2026-10-27T00:10:00Z"), "UTC")).toEqual({ kind: "gym", date: "2026-10-26" });
    expect(reminderDue({ ...r, skipDate: "2026-10-26" }, [], at("2026-10-27T00:10:00Z"), "UTC")).toBeNull();
    // Skipping the new day does not cancel last night's late reminder.
    expect(reminderDue({ ...r, skipDate: "2026-10-27" }, [], at("2026-10-27T00:10:00Z"), "UTC")).toEqual({ kind: "gym", date: "2026-10-26" });
  });
  it("year and leap-day roll over", () => {
    expect(shiftDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDate("2027-01-01", -1)).toBe("2026-12-31");
    const r = settings({ days: [], time: "23:50" });
    expect(reminderDue(r, ["2026-12-31"], at("2027-01-01T00:20:00Z"), "UTC")).toEqual({ kind: "gym", date: "2026-12-31" });
  });
  it("date line zones: the same instant is two different local days", () => {
    const t = at("2026-10-26T11:30:00Z");
    expect(localParts(t, "Pacific/Kiritimati").date).toBe("2026-10-27");
    expect(localParts(t, "Pacific/Pago_Pago").date).toBe("2026-10-26");
  });
});

describe("snooze and skip", () => {
  const MON = "2026-10-26";
  it("snooze fires once, in the tick whose window contains its end", () => {
    const r = settings({ days: [], time: "18:00", snoozedUntil: `${MON}T09:20:00Z` });
    const hits: number[] = [];
    for (let h = 0; h < 24; h++) {
      const now = at(`${MON}T00:00:00Z`).getTime() + h * 60 * MIN + 37 * MIN;
      if (reminderDue(r, [], new Date(now), "UTC")?.kind === "snooze") hits.push(h);
    }
    expect(hits).toEqual([9]);
  });
  it("snooze over a gym reminder: gym suppressed when snooze is later the same day, snooze fires", () => {
    const r = settings({ days: [1], time: "18:00", snoozedUntil: `${MON}T18:30:00Z` });
    expect(reminderDue(r, [], at(`${MON}T18:45:00Z`), "UTC")).toEqual({ kind: "snooze" });
    expect(reminderDue(r, [], at(`${MON}T18:20:00Z`), "UTC")).toBeNull();
  });
  it("snooze that ended before the gym time does not hide the gym reminder", () => {
    const r = settings({ days: [1], time: "18:00", snoozedUntil: `${MON}T10:00:00Z` });
    expect(reminderDue(r, [], at(`${MON}T18:10:00Z`), "UTC")).toEqual({ kind: "gym", date: MON });
  });
  it("snooze set for the skipped local day is silent in any zone", () => {
    const r = settings({ days: [], time: "18:00", snoozedUntil: "2026-10-26T20:00:00Z", skipDate: "2026-10-27" });
    // 20:00Z is Tuesday 05:00 in Tokyo (skipped), Monday in UTC (not skipped).
    expect(reminderDue(r, [], at("2026-10-26T20:10:00Z"), "Asia/Tokyo")).toBeNull();
    expect(reminderDue(r, [], at("2026-10-26T20:10:00Z"), "UTC")).toEqual({ kind: "snooze" });
  });
  it("future snooze or invalid snooze date never fires early", () => {
    const r = settings({ days: [], snoozedUntil: "2026-10-26T20:00:00Z" });
    expect(reminderDue(r, [], at("2026-10-26T19:59:59Z"), "UTC")).toBeNull();
    expect(reminderDue(settings({ snoozedUntil: "2026-13-45T99:00:00Z" }), [], at("2026-10-26T19:59:59Z"), "UTC")).toBeNull();
  });
  it("skipDate also blocks a marked date", () => {
    const r = settings({ days: [], time: "18:00", skipDate: "2026-10-28" });
    expect(reminderDue(r, ["2026-10-28"], at("2026-10-28T18:10:00Z"), "UTC")).toBeNull();
  });
});

// Agreement with nextReminder() (client, uses the process time zone). Only the zone
// of this machine can be used, so the cases avoid DST transitions.
describe("agrees with nextReminder minute by minute (no DST in range)", () => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cases: { name: string; r: ReminderSettings; dates: string[] }[] = [
    { name: "weekdays", r: settings({ days: [1, 3, 5], time: "18:00" }), dates: [] },
    { name: "midnight", r: settings({ days: [2], time: "00:00" }), dates: [] },
    { name: "late", r: settings({ days: [0, 6], time: "23:59" }), dates: [] },
    { name: "marked only", r: settings({ days: [], time: "07:05" }), dates: ["2026-07-14", "2026-07-16"] },
    { name: "skip", r: settings({ days: [1, 2, 3], time: "09:00", skipDate: "2026-07-14" }), dates: ["2026-07-16"] },
    { name: "snooze same day", r: settings({ days: [2], time: "06:00", snoozedUntil: "2026-07-14T09:30:00" }), dates: [] },
    { name: "snooze on marked", r: settings({ days: [], time: "06:00", snoozedUntil: "2026-07-16T07:15:00" }), dates: ["2026-07-16"] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      // Mid-July: no DST change in the northern or southern hemisphere zones in use.
      let t = new Date(2026, 6, 13, 0, 0, 0);
      for (let i = 0; i < 4; i++) {
        const next = nextReminder(c.r, t, c.dates);
        if (!next) break;
        const d = reminderDue(c.r, c.dates, next, tz, 1);
        expect(d, `${c.name} at ${next.toISOString()}`).not.toBeNull();
        // one minute early is never due
        expect(reminderDue(c.r, c.dates, new Date(next.getTime() - MIN), tz, 1), `early ${next.toISOString()}`).toBeNull();
        // Walk every minute between: due only at `next`.
        for (let m = t.getTime() + MIN; m < next.getTime(); m += 11 * MIN) {
          if (reminderDue(c.r, c.dates, new Date(m), tz, 1)) throw new Error(`${c.name}: due early at ${new Date(m).toISOString()}, next=${next.toISOString()}`);
        }
        t = next;
      }
    });
  }
  it("toggleSkipToday / toggleSnooze outputs behave the same on both sides", () => {
    const now = new Date(2026, 6, 14, 5, 0, 0);
    const base = settings({ days: [2], time: "06:00" });
    const skipped = toggleSkipToday(base, now);
    expect(nextReminder(skipped, now)!.getDate()).toBe(21);
    expect(reminderDue(skipped, [], new Date(2026, 6, 14, 6, 5, 0), tz)).toBeNull();
    expect(reminderDue(skipped, [], new Date(2026, 6, 21, 6, 5, 0), tz)).toEqual({ kind: "gym", date: "2026-07-21" });
    const snoozed = toggleSnooze({ ...base, snoozeMin: 120 }, now); // until 07:00
    expect(nextReminder(snoozed, now)!.getHours()).toBe(7);
    expect(reminderDue(snoozed, [], new Date(2026, 6, 14, 6, 10, 0), tz, 30)).toBeNull();
    expect(reminderDue(snoozed, [], new Date(2026, 6, 14, 7, 10, 0), tz, 30)).toEqual({ kind: "snooze" });
    expect(localDateKey(new Date(2026, 6, 14))).toBe("2026-07-14");
  });
});

// DST: the server uses the wall clock, so a spring-forward gap or fall-back overlap
// must not lose or duplicate the day's reminder.
describe("DST in the user's zone (America/New_York)", () => {
  const NY = "America/New_York";
  it("spring forward 2026-03-08: a 02:30 reminder is skipped that day (documents the gap)", () => {
    const r = settings({ days: [0], time: "02:30" }); // 2026-03-08 is a Sunday
    let fired = 0;
    for (let m = 0; m < 24 * 60; m += 5) {
      const t = new Date(at("2026-03-08T05:00:00Z").getTime() + m * MIN); // local midnight EST
      if (reminderDue(r, [], t, NY, 5)?.kind === "gym") fired++;
    }
    // A user who set 02:30 expects one reminder that Sunday (the local clock jumps to 03:00 -> 03:30).
    expect(fired).toBe(1);
  });
  it("fall back 2026-11-01: a 01:30 reminder fires once, not twice", () => {
    const r = settings({ days: [0], time: "01:30" }); // 2026-11-01 is a Sunday
    let fired = 0;
    for (let m = 0; m < 25 * 60; m += 5) {
      const t = new Date(at("2026-11-01T04:00:00Z").getTime() + m * MIN); // local midnight EDT
      if (reminderDue(r, [], t, NY, 5)?.kind === "gym") fired++;
    }
    expect(fired).toBe(1);
  });
  it("ordinary reminders around the transitions still fire once", () => {
    for (const [start, day, time] of [["2026-03-08T05:00:00Z", 0, "18:00"], ["2026-11-01T04:00:00Z", 0, "18:00"], ["2026-03-08T05:00:00Z", 0, "03:30"], ["2026-11-01T04:00:00Z", 0, "00:30"]] as const) {
      const r = settings({ days: [day], time });
      let fired = 0;
      for (let m = 0; m < 25 * 60; m += 60) if (reminderDue(r, [], new Date(at(start).getTime() + m * MIN + 7 * MIN), NY)?.kind === "gym") fired++;
      expect(fired, `${start} ${time}`).toBe(1);
    }
  });
  it("Lord Howe (30 minute DST) does not throw and fires once on an ordinary day", () => {
    const r = settings({ days: [0, 1, 2, 3, 4, 5, 6], time: "12:00" });
    let fired = 0;
    for (let m = 0; m < 24 * 60; m += 60) if (reminderDue(r, [], new Date(at("2026-10-04T00:00:00Z").getTime() + m * MIN + 5 * MIN), "Australia/Lord_Howe")?.kind === "gym") fired++;
    expect(fired).toBe(1);
  });
});

describe("payload", () => {
  it("is plain and stable per kind", () => {
    const g = reminderPayload({ kind: "gym", date: "2026-10-26" });
    const s = reminderPayload({ kind: "snooze" });
    expect(g.tag).not.toBe(s.tag);
    expect(JSON.stringify(g)).not.toMatch(/[<>]/);
    expect(g.url).toBe("/");
  });
});
