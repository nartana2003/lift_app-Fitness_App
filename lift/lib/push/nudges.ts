/**
 * Pure, server-safe. The two extra reminder nudges the /api/cron/reminders job
 * can send next to the gym-day reminder (lib/push/schedule.ts):
 *
 * - "haven't gone yet": on a planned day (usual weekday or a date marked on the
 *   This Week strip), when no workout has started by the usual start time plus
 *   one hour. Opt-in with the "Smart reminders" switch (settings.smart). The
 *   usual time is learned from recent workout start times like
 *   usualStartTime() in lib/reminders.ts, in the user's time zone; with too
 *   little history the saved reminder time is used instead.
 * - "behind on weekly goal": on Thursday at the reminder time, when any muscle
 *   is short of its weekly set target (Monday to now). Uses the "You're behind
 *   nudge" switch (settings.behindNudge).
 *
 * Both are silent on a skipped day and while a snooze is running, and each is
 * due in the same (now - windowMin, now] window as the gym reminder, so it is
 * sent once.
 */
import type { ReminderSettings, SnoozeMin } from "../reminders";
import { goalProgress } from "../stats";
import { DEFAULT_WINDOW_MIN, localParts, normalizeServerReminder, safeTimeZone, shiftDate, zonedInstant, type ServerReminder } from "./schedule";

export type NudgeReminder = ServerReminder & Pick<ReminderSettings, "smart" | "behindNudge" | "snoozeMin">;

/** Copies of the lib/reminders.ts values (a client-only module); nudges.test.ts checks they agree. */
export const NUDGE_SNOOZE_OPTIONS = [15, 30, 60, 120] as const satisfies readonly SnoozeMin[];
type _AllSnoozes = Exclude<SnoozeMin, (typeof NUDGE_SNOOZE_OPTIONS)[number]> extends never ? true : never;
const _allSnoozes: _AllSnoozes = true;
void _allSnoozes;
export const NUDGE_MIN_WORKOUTS = 5;
export const NUDGE_RECENT_WORKOUTS = 20;
export const NUDGE_DAY_START_MIN = 4 * 60;

/** Minutes after the usual start time before "haven't gone yet" is sent. */
export const NOT_YET_AFTER_MIN = 60;
/** JS weekday of the "behind" nudge (Thursday). */
export const BEHIND_WEEKDAY = 4;

/** Stored settings to clean values, with the nudge switches. Defaults match DEFAULT_REMINDERS. */
export function normalizeNudgeReminder(raw: unknown): NudgeReminder {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    ...normalizeServerReminder(raw),
    smart: typeof r.smart === "boolean" ? r.smart : false,
    behindNudge: typeof r.behindNudge === "boolean" ? r.behindNudge : true,
    snoozeMin: (NUDGE_SNOOZE_OPTIONS as readonly unknown[]).includes(r.snoozeMin) ? (r.snoozeMin as SnoozeMin) : 60,
  };
}

/** A logged set from this week, with its workout's start time. */
export type NudgeSet = { started_at: string; exercise_id: string; is_warmup?: boolean };

/** What the job loads per user for the nudges. */
export type NudgeData = {
  /** Workout start times (ISO), any order. */
  workoutStarts: string[];
  /** Sets from workouts of the last 8 days. */
  weekSets: NudgeSet[];
  /** Weekly set target per muscle group. */
  targets: Record<string, number>;
};

export type DueNudge =
  | { kind: "not-yet"; date: string; time: string; learned: boolean }
  | { kind: "behind"; date: string; setsLeft: number; muscles: number };

const ISO_START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const p2 = (n: number) => String(n).padStart(2, "0");
const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const weekdayOf = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/**
 * usualStartTime() from lib/reminders.ts, on the wall clock of `timeZone`
 * instead of the machine's: median start time of the most recent workouts
 * (starts before 04:00 count as late the evening before), or null with fewer
 * than NUDGE_MIN_WORKOUTS usable starts. Starts after `now` are ignored.
 */
export function usualStartTimeIn(startedAts: readonly string[], timeZone: string, now?: Date): string | null {
  const tz = safeTimeZone(timeZone);
  const nowMs = now ? now.getTime() : Number.POSITIVE_INFINITY;
  const times = startedAts
    .filter((s): s is string => typeof s === "string" && ISO_START_RE.test(s))
    .map((s) => Date.parse(s))
    .filter((t) => !Number.isNaN(t) && t <= nowMs)
    .sort((a, b) => b - a)
    .slice(0, NUDGE_RECENT_WORKOUTS);
  if (times.length < NUDGE_MIN_WORKOUTS) return null;
  const minutes = times
    .map((t) => {
      const m = localParts(new Date(t), tz).minutes;
      return m < NUDGE_DAY_START_MIN ? m + 24 * 60 : m;
    })
    .sort((a, b) => a - b);
  const mid = Math.floor(minutes.length / 2);
  const median = minutes.length % 2 ? minutes[mid] : (minutes[mid - 1] + minutes[mid]) / 2;
  const total = Math.round(median) % (24 * 60);
  return `${p2(Math.floor(total / 60))}:${p2(total % 60)}`;
}

/** The local date (today or yesterday) whose `minutes` + `afterMin` falls in the window ending at `now`. */
function dueDate(now: Date, tz: string, minutes: number, afterMin: number, windowMin: number): string | null {
  const nowMs = now.getTime();
  const today = localParts(now, tz).date;
  for (const back of [0, 1]) {
    const date = shiftDate(today, -back);
    const at = zonedInstant(date, minutes, tz) + afterMin * 60_000;
    if (nowMs - at >= 0 && nowMs - at < windowMin * 60_000) return date;
  }
  return null;
}

const snoozing = (r: NudgeReminder, now: Date) => !!r.snoozedUntil && Date.parse(r.snoozedUntil) > now.getTime();

/** "Haven't gone yet" due in the window ending at `now`, or null. */
export function notYetDue(
  raw: unknown,
  gymDates: readonly string[],
  data: Pick<NudgeData, "workoutStarts">,
  now: Date,
  timeZone: string,
  windowMin: number = DEFAULT_WINDOW_MIN,
): DueNudge | null {
  const r = normalizeNudgeReminder(raw);
  if (!r.smart || snoozing(r, now)) return null;
  const tz = safeTimeZone(timeZone);
  const learned = usualStartTimeIn(data.workoutStarts, tz, now);
  const time = learned ?? r.time;
  const date = dueDate(now, tz, toMin(time), NOT_YET_AFTER_MIN, windowMin);
  if (!date || date === r.skipDate) return null;
  if (!r.days.includes(weekdayOf(date)) && !gymDates.includes(date)) return null;
  const nowMs = now.getTime();
  const trained = data.workoutStarts.some((s) => {
    const t = typeof s === "string" && ISO_START_RE.test(s) ? Date.parse(s) : NaN;
    return Number.isFinite(t) && t <= nowMs && localParts(new Date(t), tz).date === date;
  });
  return trained ? null : { kind: "not-yet", date, time, learned: learned !== null };
}

/**
 * "Behind on weekly goal" due in the window ending at `now`, or null.
 * `muscleOf` gives an exercise's primary muscle groups (sets are credited to
 * each, like periodStats() in lib/progress.ts); warm-ups do not count.
 */
export function behindDue(
  raw: unknown,
  data: Pick<NudgeData, "weekSets" | "targets">,
  muscleOf: (exerciseId: string) => readonly string[],
  now: Date,
  timeZone: string,
  windowMin: number = DEFAULT_WINDOW_MIN,
): DueNudge | null {
  const r = normalizeNudgeReminder(raw);
  if (!r.behindNudge || snoozing(r, now)) return null;
  const tz = safeTimeZone(timeZone);
  const date = dueDate(now, tz, toMin(r.time), 0, windowMin);
  if (!date || date === r.skipDate || weekdayOf(date) !== BEHIND_WEEKDAY) return null;

  const monday = shiftDate(date, -((weekdayOf(date) + 6) % 7));
  const nowMs = now.getTime();
  const sets: Record<string, number> = {};
  for (const s of data.weekSets) {
    if (s.is_warmup || typeof s.started_at !== "string") continue;
    const t = Date.parse(s.started_at);
    if (!Number.isFinite(t) || t > nowMs) continue;
    const day = localParts(new Date(t), tz).date;
    if (day < monday || day > date) continue;
    for (const m of muscleOf(s.exercise_id)) sets[m] = (sets[m] ?? 0) + 1;
  }
  const targets: Record<string, number> = {};
  for (const [m, n] of Object.entries(data.targets)) if (Number.isInteger(n) && n > 0) targets[m] = n;
  const short = goalProgress(sets, targets).filter((g) => g.remaining > 0);
  if (!short.length) return null;
  return { kind: "behind", date, setsLeft: short.reduce((a, g) => a + g.remaining, 0), muscles: short.length };
}

export type NudgePayload = { title: string; body: string; url: string; tag: string; kind: "reminder" };

/** Notification shown by public/sw.js. Plain text, no emojis. */
export function nudgePayload(due: DueNudge): NudgePayload {
  if (due.kind === "not-yet") {
    return {
      title: "Lift",
      body: due.learned
        ? `You usually train at ${due.time} and haven't gone yet today.`
        : `You planned to train at ${due.time} and haven't gone yet today.`,
      url: "/",
      tag: `lift-not-yet-${due.date}`,
      kind: "reminder",
    };
  }
  const sets = due.setsLeft === 1 ? "1 set" : `${due.setsLeft} sets`;
  const muscles = due.muscles === 1 ? "1 muscle" : `${due.muscles} muscles`;
  return {
    title: "Lift",
    body: `You're behind on your weekly goal: ${sets} left across ${muscles}.`,
    url: "/",
    tag: `lift-behind-${due.date}`,
    kind: "reminder",
  };
}

export type NotificationAction = { action: "skip" | "snooze"; title: string };

/** Skip today and Snooze buttons on a planned-day notification. */
export function reminderActions(snoozeMin: number): NotificationAction[] {
  const label = snoozeMin < 60 ? `${snoozeMin} min` : `${snoozeMin / 60} h`;
  return [
    { action: "skip", title: "Skip today" },
    { action: "snooze", title: `Snooze ${label}` },
  ];
}
