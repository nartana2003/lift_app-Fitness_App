import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../offline/db";
import {
  DEFAULT_REMINDERS,
  formatNext,
  getMarkedGymDates,
  getRecentWorkoutStarts,
  getReminders,
  isSkippedToday,
  isSnoozed,
  isValidTime,
  localDateKey,
  nextReminder,
  normalizeReminders,
  orderedDays,
  REMINDERS_KEY,
  reminderSummary,
  saveReminders,
  SMART_DAY_START_MIN,
  SMART_MIN_WORKOUTS,
  SMART_RECENT_WORKOUTS,
  suggestedReminderTime,
  toggleDayIn,
  toggleSkipToday,
  toggleSnooze,
  updateReminders,
  usualStartTime,
  type ReminderSettings,
} from "../reminders";

const r = (p: Partial<ReminderSettings> = {}): ReminderSettings => ({ ...DEFAULT_REMINDERS, ...p });
// 2026-10-21 is a Wednesday (getDay 3). Local time throughout.
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m, 0, 0);

describe("normalizeReminders", () => {
  it("falls back to defaults for missing or malformed input", () => {
    expect(normalizeReminders(undefined)).toEqual(DEFAULT_REMINDERS);
    expect(normalizeReminders("x")).toEqual(DEFAULT_REMINDERS);
    expect(normalizeReminders([1, 2])).toEqual(DEFAULT_REMINDERS);
  });

  it("cleans days, time, flags, snooze length and dates", () => {
    const n = normalizeReminders({
      days: [5, 1, 1, 7, -1, 2.5, "3", 0],
      time: "25:00",
      behindNudge: "yes",
      smart: true,
      snoozeMin: 45,
      skipDate: "today",
      snoozedUntil: "not a date",
    });
    expect(n).toEqual({ ...DEFAULT_REMINDERS, days: [0, 1, 5], smart: true });
  });

  it("keeps valid values", () => {
    const good = r({ days: [1, 3], time: "06:30", behindNudge: false, snoozeMin: 15, skipDate: "2026-10-21", snoozedUntil: at(21, 19).toISOString() });
    expect(normalizeReminders(good)).toEqual(good);
  });
});

describe("helpers", () => {
  it("validates 24h times", () => {
    expect(isValidTime("00:00")).toBe(true);
    expect(isValidTime("23:59")).toBe(true);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("7:00")).toBe(false);
    expect(isValidTime(700)).toBe(false);
  });

  it("toggles days and keeps them sorted", () => {
    expect(toggleDayIn([1, 5], 3)).toEqual([1, 3, 5]);
    expect(toggleDayIn([1, 3, 5], 3)).toEqual([1, 5]);
    expect(toggleDayIn([1], 9)).toEqual([1]);
  });

  it("orders days by week start", () => {
    expect(orderedDays(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(orderedDays(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("summarises the schedule", () => {
    expect(reminderSummary(r())).toBe("Off");
    expect(reminderSummary(r({ days: [0, 1, 3] }), 1)).toBe("Mon, Wed, Sun at 18:00");
    expect(reminderSummary(r({ days: [0, 1, 3] }), 0)).toBe("Sun, Mon, Wed at 18:00");
    expect(reminderSummary(r({ days: [0, 1, 2, 3, 4, 5, 6], time: "07:15" }))).toBe("Every day at 07:15");
  });

  it("formats the next-reminder line", () => {
    const now = at(21, 10);
    expect(formatNext(at(21, 18), now)).toBe("Today 18:00");
    expect(formatNext(at(22, 7, 5), now)).toBe("Tomorrow 07:05");
    expect(formatNext(at(24, 18), now)).toBe("Sat 18:00");
  });
});

describe("nextReminder", () => {
  it("is null with no gym days", () => {
    expect(nextReminder(r(), at(21, 10))).toBeNull();
  });

  it("finds today's reminder if it is still ahead", () => {
    expect(nextReminder(r({ days: [3] }), at(21, 10))).toEqual(at(21, 18));
  });

  it("moves to the next gym day once today's time has passed", () => {
    expect(nextReminder(r({ days: [3, 5] }), at(21, 19))).toEqual(at(23, 18));
    // Only Wednesday: a week later.
    expect(nextReminder(r({ days: [3] }), at(21, 19))).toEqual(at(28, 18));
  });

  it("skips today's reminder when today is skipped", () => {
    const s = r({ days: [3, 4], skipDate: "2026-10-21" });
    expect(nextReminder(s, at(21, 10))).toEqual(at(22, 18));
  });

  it("replaces today's reminder with the snooze end", () => {
    const s = r({ days: [3], snoozedUntil: at(21, 18, 30).toISOString() });
    expect(nextReminder(s, at(21, 17, 30))).toEqual(at(21, 18, 30));
    // After the snooze ends the next regular one is due.
    expect(nextReminder(s, at(21, 18, 45))).toEqual(at(28, 18));
  });

  it("uses a snooze even on a non gym day", () => {
    const s = r({ days: [5], snoozedUntil: at(21, 11).toISOString() });
    expect(nextReminder(s, at(21, 10))).toEqual(at(21, 11));
  });
});

describe("skip and snooze", () => {
  const now = at(21, 17);

  it("skip today toggles on and off and clears a snooze", () => {
    const snoozed = toggleSnooze(r({ days: [3] }), now);
    expect(isSnoozed(snoozed, now)).toBe(true);
    const skipped = toggleSkipToday(snoozed, now);
    expect(isSkippedToday(skipped, now)).toBe(true);
    expect(isSnoozed(skipped, now)).toBe(false);
    expect(isSkippedToday(toggleSkipToday(skipped, now), now)).toBe(false);
  });

  it("snooze uses the chosen length, cancels, and un-skips today", () => {
    const s = toggleSnooze(r({ snoozeMin: 30, skipDate: localDateKey(now) }), now);
    expect(s.snoozedUntil).toBe(at(21, 17, 30).toISOString());
    expect(s.skipDate).toBeNull();
    expect(toggleSnooze(s, now).snoozedUntil).toBeNull();
    // An expired snooze is not active.
    expect(isSnoozed(s, at(21, 18))).toBe(false);
  });
});

describe("storage", () => {
  beforeEach(async () => {
    await db.meta.clear();
  });

  it("returns defaults until something is saved", async () => {
    expect(await getReminders()).toEqual(DEFAULT_REMINDERS);
  });

  it("saves cleaned settings and updates in place", async () => {
    await saveReminders({ ...DEFAULT_REMINDERS, days: [4, 4, 2] });
    expect((await db.meta.get(REMINDERS_KEY))?.value).toEqual({ ...DEFAULT_REMINDERS, days: [2, 4] });
    const next = await updateReminders((cur) => ({ ...cur, time: "07:00", days: toggleDayIn(cur.days, 2) }));
    expect(next).toEqual({ ...DEFAULT_REMINDERS, days: [4], time: "07:00" });
    expect(await getReminders()).toEqual(next);
  });
});

describe("nextReminder with marked gym dates", () => {
  // now is Wednesday 2026-10-21.
  it("without dates or with an empty list it is the weekday schedule", () => {
    expect(nextReminder(r(), at(21, 10), [])).toBeNull();
    expect(nextReminder(r(), at(21, 10), undefined)).toBeNull();
    expect(nextReminder(r({ days: [5] }), at(21, 10), [])).toEqual(nextReminder(r({ days: [5] }), at(21, 10)));
    expect(nextReminder(r({ days: [5] }), at(21, 10), [])).toEqual(at(23, 18));
  });

  it("uses the earliest marked date, whatever order they come in", () => {
    expect(nextReminder(r(), at(21, 10), ["2026-10-29", "2026-10-24", "2026-10-26"])).toEqual(at(24, 18));
  });

  it("uses today when the reminder time is still ahead, the next date once it has passed", () => {
    const dates = ["2026-10-21", "2026-10-23"];
    expect(nextReminder(r(), at(21, 17, 59), dates)).toEqual(at(21, 18));
    expect(nextReminder(r(), at(21, 18), dates)).toEqual(at(23, 18));
    expect(nextReminder(r(), at(21, 19), ["2026-10-21"])).toBeNull();
  });

  it("follows dates more than a week ahead", () => {
    expect(nextReminder(r(), at(21, 10), ["2026-11-15"])).toEqual(new Date(2026, 10, 15, 18, 0, 0, 0));
  });

  it("ignores past dates and junk", () => {
    expect(nextReminder(r(), at(21, 10), ["2026-10-20", "2026-10-01"])).toBeNull();
    expect(nextReminder(r(), at(21, 10), ["2026-02-30", "tomorrow", "2026-10-20", "2026-10-25"])).toEqual(at(25, 18));
  });

  it("skips today when today is skipped", () => {
    const s = r({ skipDate: "2026-10-21" });
    expect(nextReminder(s, at(21, 10), ["2026-10-21", "2026-10-22"])).toEqual(at(22, 18));
    expect(nextReminder(s, at(21, 10), ["2026-10-21"])).toBeNull();
  });

  it("a snooze replaces the reminder on a marked date and works with only dates", () => {
    const s = r({ snoozedUntil: at(21, 18, 30).toISOString() });
    expect(nextReminder(s, at(21, 17, 30), ["2026-10-21", "2026-10-24"])).toEqual(at(21, 18, 30));
    expect(nextReminder(s, at(21, 18, 45), ["2026-10-21", "2026-10-24"])).toEqual(at(24, 18));
    // A snooze on a day with no marked date still comes first.
    expect(nextReminder(r({ snoozedUntil: at(21, 11).toISOString() }), at(21, 10), ["2026-10-24"])).toEqual(at(21, 11));
  });

  it("combines marked dates with usual weekdays, earliest first", () => {
    // Usual Friday (23rd) vs marked Thursday (22nd): Thursday.
    expect(nextReminder(r({ days: [5] }), at(21, 10), ["2026-10-22"])).toEqual(at(22, 18));
    // Usual Friday (23rd) vs marked Saturday (24th): Friday.
    expect(nextReminder(r({ days: [5] }), at(21, 10), ["2026-10-24"])).toEqual(at(23, 18));
    // A marked date that is also a usual day counts once.
    expect(nextReminder(r({ days: [4] }), at(21, 10), ["2026-10-22"])).toEqual(at(22, 18));
    // Uses the reminder time.
    expect(nextReminder(r({ days: [5], time: "06:15" }), at(21, 10), ["2026-10-22"])).toEqual(at(22, 6, 15));
  });
});

describe("getMarkedGymDates", () => {
  beforeEach(async () => {
    await db.planned_days.clear();
  });

  const row = (date: string, status: "planned" | "done" | "skipped" | "moved") => ({
    id: `d-${date}`,
    date,
    routine_id: null,
    status,
    workout_id: null,
    skip_reason: null,
    skip_note: null,
    moved_to: null,
    moved_from: null,
    created_at: "2026-10-01T00:00:00.000Z",
  });

  it("returns planned dates from today on, sorted, and leaves out other statuses", async () => {
    await db.planned_days.bulkAdd([
      row("2026-10-25", "planned"),
      row("2026-10-20", "planned"),
      row("2026-10-21", "planned"),
      row("2026-10-22", "done"),
      row("2026-10-23", "skipped"),
      row("2026-10-24", "moved"),
      row("2026-10-30", "planned"),
    ]);
    expect(await getMarkedGymDates("2026-10-21")).toEqual(["2026-10-21", "2026-10-25", "2026-10-30"]);
  });

  it("is empty with nothing marked", async () => {
    expect(await getMarkedGymDates("2026-10-21")).toEqual([]);
  });
});

describe("usualStartTime (smart reminder time)", () => {
  // Local times turned into ISO strings, like workouts.started_at.
  const iso = (day: number, h: number, m = 0) => at(day, h, m).toISOString();

  it("needs at least 5 workouts", () => {
    expect(usualStartTime([])).toBeNull();
    expect(usualStartTime([iso(1, 18), iso(2, 18), iso(3, 18), iso(4, 18)])).toBeNull();
    expect(usualStartTime([iso(1, 18), iso(2, 18), iso(3, 18), iso(4, 18), iso(5, 18)])).toBe("18:00");
    expect(SMART_MIN_WORKOUTS).toBe(5);
  });

  it("is the median local start time, not the mean", () => {
    // One very early outlier does not drag it down.
    expect(usualStartTime([iso(1, 6), iso(2, 18, 10), iso(3, 18, 30), iso(5, 18, 40), iso(6, 19)])).toBe("18:30");
  });

  it("averages the two middle values for an even count, rounded to the minute", () => {
    const starts = [iso(1, 17), iso(2, 17, 30), iso(3, 18), iso(5, 18, 15), iso(6, 18, 45), iso(7, 19)];
    // Middle two: 18:00 and 18:15.
    expect(usualStartTime(starts)).toBe("18:08");
    expect(usualStartTime([iso(1, 7), iso(2, 7), iso(3, 7, 1), iso(4, 7, 2), iso(5, 7, 2), iso(6, 7, 3)])).toBe("07:02");
  });

  it("ignores order and junk", () => {
    const starts = ["nope", iso(5, 6, 5), "", iso(1, 6, 5), iso(3, 6, 0), "2026-13-45T99:00", iso(2, 6, 10), iso(4, 6, 20)];
    expect(usualStartTime(starts)).toBe("06:05");
    expect(usualStartTime(["x", "y", "z", "w", iso(1, 6)])).toBeNull();
  });

  it("uses only the most recent workouts", () => {
    // 20 old mornings, then 5 recent evenings: with a recent window of 5 only evenings count.
    const old = Array.from({ length: 20 }, (_, i) => new Date(2026, 8, i + 1, 7, 0).toISOString());
    const recent = [iso(1, 19), iso(2, 19), iso(3, 19, 30), iso(4, 20), iso(5, 20)];
    expect(usualStartTime([...old, ...recent], { recent: 5 })).toBe("19:30");
    // Default window is the last 20: 15 mornings and 5 evenings, median is morning.
    expect(SMART_RECENT_WORKOUTS).toBe(20);
    expect(usualStartTime([...recent, ...old])).toBe("07:00");
  });

  it("accepts a custom minimum", () => {
    expect(usualStartTime([iso(1, 9), iso(2, 10)], { min: 2 })).toBe("09:30");
    expect(usualStartTime([iso(1, 9), iso(2, 10)], { min: 3 })).toBeNull();
  });
});

describe("suggestedReminderTime", () => {
  const five = (h: number, m = 0) => [1, 2, 3, 4, 5].map((d) => at(d, h, m).toISOString());

  it("suggests the usual time when it differs from the saved time", () => {
    expect(suggestedReminderTime(r({ time: "18:00" }), five(17, 45))).toBe("17:45");
  });

  it("suggests nothing when it already matches or there is too little history", () => {
    expect(suggestedReminderTime(r({ time: "17:45" }), five(17, 45))).toBeNull();
    expect(suggestedReminderTime(r(), five(17, 45).slice(0, 4))).toBeNull();
  });

  it("never changes the settings it is given", () => {
    const s = r({ days: [1], time: "18:00" });
    const copy = structuredClone(s);
    suggestedReminderTime(s, five(6));
    expect(s).toEqual(copy);
  });
});

describe("getRecentWorkoutStarts", () => {
  beforeEach(async () => {
    await db.workouts.clear();
  });

  it("returns the newest start times first, up to the limit", async () => {
    const w = (id: string, started_at: string) => ({ id, started_at, ended_at: null, notes: null, routine_id: null });
    await db.workouts.bulkAdd([
      w("a", "2026-10-01T18:00:00.000Z"),
      w("b", "2026-10-03T18:00:00.000Z"),
      w("c", "2026-10-02T18:00:00.000Z"),
    ]);
    expect(await getRecentWorkoutStarts()).toEqual(["2026-10-03T18:00:00.000Z", "2026-10-02T18:00:00.000Z", "2026-10-01T18:00:00.000Z"]);
    expect(await getRecentWorkoutStarts(2)).toEqual(["2026-10-03T18:00:00.000Z", "2026-10-02T18:00:00.000Z"]);
  });

  it("is empty with no workouts", async () => {
    expect(await getRecentWorkoutStarts()).toEqual([]);
  });
});

describe("usualStartTime midnight wrap, strict dates and future starts", () => {
  const iso = (day: number, h: number, m = 0) => at(day, h, m).toISOString();

  it("3x 23:50 and 3x 00:10 gives midnight, not midday", () => {
    expect(usualStartTime([iso(1, 23, 50), iso(2, 23, 50), iso(3, 23, 50), iso(4, 0, 10), iso(5, 0, 10), iso(6, 0, 10)])).toBe("00:00");
  });

  it("late-night starts on both sides of midnight stay near midnight", () => {
    expect(usualStartTime([iso(1, 23, 30), iso(2, 23, 45), iso(3, 0, 15), iso(4, 0, 30), iso(5, 1)])).toBe("00:15");
    expect(usualStartTime([iso(1, 23), iso(2, 23), iso(3, 23, 30), iso(4, 0, 10), iso(5, 23, 40)])).toBe("23:30");
  });

  it("starts from 04:00 on use plain clock order", () => {
    expect(SMART_DAY_START_MIN).toBe(240);
    expect(usualStartTime([iso(1, 4), iso(2, 4), iso(3, 4), iso(4, 4), iso(5, 4)])).toBe("04:00");
    expect(usualStartTime([iso(1, 3, 59), iso(2, 3, 59), iso(3, 3, 59), iso(4, 3, 59), iso(5, 3, 59)])).toBe("03:59");
  });

  it("ignores strings that are not ISO-like date-times", () => {
    const five = [1, 2, 3, 4, 5].map((d) => iso(d, 7));
    expect(usualStartTime(["1", "2", "3", "4", iso(1, 7)])).toBeNull();
    expect(usualStartTime(["2026-10-01", "Oct 2 2026 07:00", ...five.slice(0, 4)])).toBeNull();
    expect(usualStartTime(["1", ...five])).toBe("07:00");
  });

  it("with now, ignores starts in the future", () => {
    const now = at(10, 12);
    const past = [1, 2, 3, 4].map((d) => iso(d, 7));
    expect(usualStartTime([...past, iso(11, 7)], { now })).toBeNull();
    expect(usualStartTime([...past, iso(10, 7)], { now })).toBe("07:00");
    // A start exactly at now counts.
    expect(usualStartTime([...past, now.toISOString()], { now, min: 5 })).toBe("07:00");
    // Future evenings do not pull the time.
    const future = [11, 12, 13, 14, 15, 16].map((d) => iso(d, 20));
    expect(usualStartTime([...past, iso(5, 7), ...future], { now })).toBe("07:00");
    expect(suggestedReminderTime(r(), [...past, iso(5, 7), ...future], now)).toBe("07:00");
    expect(suggestedReminderTime(r(), [...past, ...future], now)).toBeNull();
  });
});
