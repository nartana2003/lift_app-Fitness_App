import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  BEHIND_WEEKDAY,
  NUDGE_DAY_START_MIN,
  NUDGE_MIN_WORKOUTS,
  NUDGE_RECENT_WORKOUTS,
  NUDGE_SNOOZE_OPTIONS,
  behindDue,
  normalizeNudgeReminder,
  notYetDue,
  nudgePayload,
  reminderActions,
  usualStartTimeIn,
  type NudgeSet,
} from "../nudges";
import { SMART_DAY_START_MIN, SMART_MIN_WORKOUTS, SMART_RECENT_WORKOUTS, SNOOZE_OPTIONS, normalizeReminders, usualStartTime } from "../../reminders";

// Monday 2026-10-26 .. Sunday 2026-11-01. Thursday is 2026-10-29.
const at = (iso: string) => new Date(iso);
/** Five past workouts starting at hh:mm UTC on earlier days. */
const starts = (hhmm: string, n = 5) => Array.from({ length: n }, (_, i) => `2026-10-${String(10 + i).padStart(2, "0")}T${hhmm}:00Z`);
const BICEPS = "biceps-curl";
const muscleOf = (id: string) => (id === BICEPS ? ["Biceps"] : id === "squat" ? ["Quads", "Glutes"] : []);
const set = (started_at: string, exercise_id = BICEPS, is_warmup = false): NudgeSet => ({ started_at, exercise_id, is_warmup });

describe("copies of lib/reminders.ts values", () => {
  it("agree", () => {
    expect([...NUDGE_SNOOZE_OPTIONS]).toEqual([...SNOOZE_OPTIONS]);
    expect(NUDGE_MIN_WORKOUTS).toBe(SMART_MIN_WORKOUTS);
    expect(NUDGE_RECENT_WORKOUTS).toBe(SMART_RECENT_WORKOUTS);
    expect(NUDGE_DAY_START_MIN).toBe(SMART_DAY_START_MIN);
    expect(BEHIND_WEEKDAY).toBe(4);
  });

  it("normalizeNudgeReminder matches normalizeReminders on the shared fields", () => {
    const inputs: unknown[] = [
      null,
      [],
      { smart: true, behindNudge: false, snoozeMin: 30, days: [1], time: "07:00" },
      { smart: "yes", behindNudge: 1, snoozeMin: 45 },
    ];
    for (const raw of inputs) {
      const a = normalizeReminders(raw);
      expect(normalizeNudgeReminder(raw)).toEqual({
        days: a.days,
        time: a.time,
        skipDate: a.skipDate,
        snoozedUntil: a.snoozedUntil,
        smart: a.smart,
        behindNudge: a.behindNudge,
        snoozeMin: a.snoozeMin,
      });
    }
  });

  it("usualStartTimeIn agrees with usualStartTime in this machine's zone", () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const lists = [
      starts("17:00"),
      [...starts("06:00", 3), ...starts("18:30", 4)],
      ["2026-10-01T23:50:00Z", "2026-10-02T00:10:00Z", "2026-10-03T23:40:00Z", "2026-10-04T00:20:00Z", "2026-10-05T00:00:00Z"],
      starts("08:00", 4),
      ["junk", "1", ...starts("12:15")],
    ];
    for (const l of lists) expect(usualStartTimeIn(l, tz)).toBe(usualStartTime(l));
  });
});

describe("usualStartTimeIn", () => {
  it("reads start times on the user's wall clock", () => {
    // 17:00 UTC is 18:00 in Berlin (CET, after 25 Oct) and 02:00 next day in Tokyo.
    const l = ["2026-10-26T17:00:00Z", "2026-10-27T17:00:00Z", "2026-10-28T17:00:00Z", "2026-10-29T17:00:00Z", "2026-10-30T17:00:00Z"];
    expect(usualStartTimeIn(l, "UTC")).toBe("17:00");
    expect(usualStartTimeIn(l, "Europe/Berlin")).toBe("18:00");
    expect(usualStartTimeIn(l, "Asia/Tokyo")).toBe("02:00");
  });

  it("needs five starts and ignores future ones", () => {
    expect(usualStartTimeIn(starts("17:00", 4), "UTC")).toBeNull();
    expect(usualStartTimeIn(starts("17:00"), "UTC", at("2026-10-12T00:00:00Z"))).toBeNull();
  });
});

describe("notYetDue (haven't gone yet)", () => {
  const r = { smart: true, days: [1], time: "07:00" };
  const data = { workoutStarts: starts("17:00") };
  const MON_18_05 = at("2026-10-26T18:05:00Z");

  it("fires an hour after the usual time on a planned weekday with no workout", () => {
    expect(notYetDue(r, [], data, MON_18_05, "UTC")).toEqual({ kind: "not-yet", date: "2026-10-26", time: "17:00", learned: true });
  });

  it("only in the window: not before usual + 1h, not an hour later", () => {
    expect(notYetDue(r, [], data, at("2026-10-26T17:59:00Z"), "UTC")).toBeNull();
    expect(notYetDue(r, [], data, at("2026-10-26T19:00:00Z"), "UTC")).toBeNull();
  });

  it("is opt-in with the smart switch", () => {
    expect(notYetDue({ ...r, smart: false }, [], data, MON_18_05, "UTC")).toBeNull();
    expect(notYetDue({ days: [1] }, [], data, MON_18_05, "UTC")).toBeNull();
  });

  it("works from a date marked on the This Week strip", () => {
    const tue = at("2026-10-27T18:05:00Z");
    expect(notYetDue(r, [], data, tue, "UTC")).toBeNull();
    expect(notYetDue(r, ["2026-10-27"], data, tue, "UTC")?.date).toBe("2026-10-27");
  });

  it("not when a workout already started that day", () => {
    const d = { workoutStarts: [...data.workoutStarts, "2026-10-26T06:00:00Z"] };
    expect(notYetDue(r, [], d, MON_18_05, "UTC")).toBeNull();
    // A workout from yesterday does not count.
    const y = { workoutStarts: [...data.workoutStarts, "2026-10-25T17:00:00Z"] };
    expect(notYetDue(r, [], y, MON_18_05, "UTC")).not.toBeNull();
  });

  it("silent on the skipped day and while snoozed", () => {
    expect(notYetDue({ ...r, skipDate: "2026-10-26" }, [], data, MON_18_05, "UTC")).toBeNull();
    expect(notYetDue({ ...r, snoozedUntil: "2026-10-26T18:30:00Z" }, [], data, MON_18_05, "UTC")).toBeNull();
    expect(notYetDue({ ...r, snoozedUntil: "2026-10-26T18:00:00Z" }, [], data, MON_18_05, "UTC")).not.toBeNull();
  });

  it("falls back to the saved reminder time with too little history", () => {
    expect(notYetDue(r, [], { workoutStarts: [] }, at("2026-10-26T08:00:00Z"), "UTC")).toEqual({
      kind: "not-yet",
      date: "2026-10-26",
      time: "07:00",
      learned: false,
    });
  });

  it("uses the user's time zone", () => {
    // Starts at 17:00 UTC in mid October (CEST) are 19:00 Berlin; due 20:00 Berlin = 19:00 UTC on Monday (CET).
    const d = { workoutStarts: starts("17:00") };
    expect(notYetDue(r, [], d, at("2026-10-26T18:05:00Z"), "Europe/Berlin")).toBeNull();
    expect(notYetDue(r, [], d, at("2026-10-26T19:05:00Z"), "Europe/Berlin")).toMatchObject({ kind: "not-yet", time: "19:00" });
  });
});

describe("behindDue (behind on weekly goal)", () => {
  const r = { time: "18:00" };
  const THU = at("2026-10-29T18:10:00Z");
  const targets = { Biceps: 4, Quads: 2 };
  const weekSets = [set("2026-10-26T17:00:00Z"), set("2026-10-27T17:00:00Z"), set("2026-10-27T17:00:00Z", "squat")];

  it("fires on Thursday at the reminder time when sets are short", () => {
    // Biceps 2/4, Quads 1/2: 3 sets left across 2 muscles. Glutes has no target.
    expect(behindDue(r, { weekSets, targets }, muscleOf, THU, "UTC")).toEqual({ kind: "behind", date: "2026-10-29", setsLeft: 3, muscles: 2 });
  });

  it("only on Thursday and only in the window", () => {
    expect(behindDue(r, { weekSets, targets }, muscleOf, at("2026-10-28T18:10:00Z"), "UTC")).toBeNull();
    expect(behindDue(r, { weekSets, targets }, muscleOf, at("2026-10-29T17:59:00Z"), "UTC")).toBeNull();
    expect(behindDue(r, { weekSets, targets }, muscleOf, at("2026-10-29T19:00:00Z"), "UTC")).toBeNull();
  });

  it("nothing when every target is met or there are no targets", () => {
    const enough = [...weekSets, set("2026-10-28T17:00:00Z"), set("2026-10-28T17:00:00Z"), set("2026-10-28T17:00:00Z", "squat")];
    expect(behindDue(r, { weekSets: enough, targets }, muscleOf, THU, "UTC")).toBeNull();
    expect(behindDue(r, { weekSets: [], targets: {} }, muscleOf, THU, "UTC")).toBeNull();
    expect(behindDue(r, { weekSets: [], targets: { Biceps: 0, Chest: -3, Back: 2.5 } }, muscleOf, THU, "UTC")).toBeNull();
  });

  it("counts Monday to now only and skips warm-ups", () => {
    const old = [set("2026-10-25T17:00:00Z"), set("2026-10-25T17:00:00Z"), set("2026-10-29T17:00:00Z", BICEPS, true)];
    expect(behindDue(r, { weekSets: old, targets: { Biceps: 1 } }, muscleOf, THU, "UTC")).toMatchObject({ kind: "behind", setsLeft: 1 });
    const later = [set("2026-10-29T19:00:00Z")];
    expect(behindDue(r, { weekSets: later, targets: { Biceps: 1 } }, muscleOf, THU, "UTC")).toMatchObject({ kind: "behind", setsLeft: 1 });
  });

  it("respects the switch, skip and snooze", () => {
    expect(behindDue({ ...r, behindNudge: false }, { weekSets, targets }, muscleOf, THU, "UTC")).toBeNull();
    expect(behindDue({ ...r, skipDate: "2026-10-29" }, { weekSets, targets }, muscleOf, THU, "UTC")).toBeNull();
    expect(behindDue({ ...r, snoozedUntil: "2026-10-29T19:00:00Z" }, { weekSets, targets }, muscleOf, THU, "UTC")).toBeNull();
  });

  it("uses the user's Thursday", () => {
    // 2026-10-29T23:10Z is Friday 08:10 in Tokyo: not Thursday there.
    expect(behindDue({ time: "23:00" }, { weekSets, targets }, muscleOf, at("2026-10-29T23:10:00Z"), "UTC")).not.toBeNull();
    expect(behindDue({ time: "08:00" }, { weekSets, targets }, muscleOf, at("2026-10-29T23:10:00Z"), "Asia/Tokyo")).toBeNull();
  });
});

describe("payloads and actions", () => {
  const noEmoji = (s: string) => !/\p{Extended_Pictographic}/u.test(s);

  it("plain text with a per-day tag", () => {
    const a = nudgePayload({ kind: "not-yet", date: "2026-10-26", time: "18:00", learned: true });
    expect(a).toEqual({ title: "Lift", body: "You usually train at 18:00 and haven't gone yet today.", url: "/", tag: "lift-not-yet-2026-10-26", kind: "reminder" });
    expect(nudgePayload({ kind: "not-yet", date: "2026-10-26", time: "07:00", learned: false }).body).toBe(
      "You planned to train at 07:00 and haven't gone yet today.",
    );
    const b = nudgePayload({ kind: "behind", date: "2026-10-29", setsLeft: 3, muscles: 2 });
    expect(b.body).toBe("You're behind on your weekly goal: 3 sets left across 2 muscles.");
    expect(b.tag).toBe("lift-behind-2026-10-29");
    expect(nudgePayload({ kind: "behind", date: "2026-10-29", setsLeft: 1, muscles: 1 }).body).toBe(
      "You're behind on your weekly goal: 1 set left across 1 muscle.",
    );
    for (const p of [a, b]) {
      expect(noEmoji(p.body)).toBe(true);
      expect(JSON.stringify(p)).not.toMatch(/[<>]/);
    }
  });

  it("Skip today and Snooze buttons follow the snooze length", () => {
    expect(reminderActions(60)).toEqual([
      { action: "skip", title: "Skip today" },
      { action: "snooze", title: "Snooze 1 h" },
    ]);
    expect(reminderActions(15)[1].title).toBe("Snooze 15 min");
  });
});
