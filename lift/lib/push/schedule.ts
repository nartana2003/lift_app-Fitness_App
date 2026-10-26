/**
 * Pure, server-safe. Decides whether a gym-day reminder is due for one user
 * when the /api/cron/reminders job runs.
 *
 * Same rules as nextReminder() in lib/reminders.ts (a client-only module, so
 * only its type is imported here; lib/push/__tests__/schedule.test.ts checks
 * the two agree): a reminder fires at the reminder time on each usual weekday
 * and on each date marked on the This Week strip, never on the skipped date,
 * and an active snooze replaces that day's earlier reminders and fires itself
 * when it ends.
 *
 * The job runs every `windowMin` minutes, so a reminder is due when its time
 * falls in the last window: (now - windowMin, now]. It is never early, and at
 * most windowMin minutes late. Times are the user's wall clock in their IANA
 * time zone (profiles.timezone); a bad zone falls back to UTC.
 */
import type { ReminderSettings } from "../reminders";

export type ServerReminder = Pick<ReminderSettings, "days" | "time" | "skipDate" | "snoozedUntil">;

/** Default cron interval (vercel.json runs the job hourly). */
export const DEFAULT_WINDOW_MIN = 60;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (d: unknown): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6;

/**
 * Stored settings (profiles.reminders jsonb) to clean values. Mirrors the
 * relevant fields of normalizeReminders() in lib/reminders.ts.
 */
export function normalizeServerReminder(raw: unknown): ServerReminder {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    days: Array.isArray(r.days) ? [...new Set(r.days.filter(isDay))].sort((a, b) => a - b) : [],
    time: typeof r.time === "string" && TIME_RE.test(r.time) ? r.time : "18:00",
    skipDate: typeof r.skipDate === "string" && DATE_RE.test(r.skipDate) ? r.skipDate : null,
    snoozedUntil: typeof r.snoozedUntil === "string" && !Number.isNaN(Date.parse(r.snoozedUntil)) ? r.snoozedUntil : null,
  };
}

/** A usable IANA zone, else "UTC". */
export function safeTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock date, weekday (0 = Sunday) and minute of day of `t` in `tz`. */
export function localParts(t: Date, tz: string): { date: string; weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone(tz),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: WEEKDAYS[get("weekday")] ?? 0,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** "YYYY-MM-DD" plus `n` days. */
export function shiftDate(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export type DueReminder = { kind: "gym"; date: string } | { kind: "snooze" };

/** The reminder due in the window ending at `now`, or null. */
export function reminderDue(
  raw: unknown,
  gymDates: readonly string[],
  now: Date,
  timeZone: string,
  windowMin: number = DEFAULT_WINDOW_MIN,
): DueReminder | null {
  const r = normalizeServerReminder(raw);
  const tz = safeTimeZone(timeZone);
  const windowMs = windowMin * 60_000;
  const nowMs = now.getTime();
  const dates = new Set(gymDates.filter((d) => typeof d === "string" && DATE_RE.test(d)));

  const snoozeMs = r.snoozedUntil ? Date.parse(r.snoozedUntil) : NaN;
  const snoozeDate = Number.isFinite(snoozeMs) ? localParts(new Date(snoozeMs), tz).date : null;

  // A snooze ending in this window fires, unless its day is skipped.
  if (Number.isFinite(snoozeMs) && nowMs - snoozeMs >= 0 && nowMs - snoozeMs < windowMs && snoozeDate !== r.skipDate) {
    return { kind: "snooze" };
  }

  const [hh, mm] = r.time.split(":").map(Number);
  const reminderMin = hh * 60 + mm;
  const lp = localParts(now, tz);
  // Today's reminder, or yesterday's when the window crosses midnight.
  for (const back of [0, 1]) {
    const agoMin = lp.minutes - reminderMin + back * 1440;
    if (agoMin < 0 || agoMin * 60_000 >= windowMs) continue;
    const date = shiftDate(lp.date, -back);
    const weekday = (lp.weekday - back + 7) % 7;
    if (!r.days.includes(weekday) && !dates.has(date)) continue;
    if (date === r.skipDate) continue;
    const at = nowMs - agoMin * 60_000;
    // An active snooze on the same day replaces reminders up to its end.
    if (snoozeDate === date && snoozeMs >= at && snoozeDate !== r.skipDate) continue;
    return { kind: "gym", date };
  }
  return null;
}

export type ReminderPayload = { title: string; body: string; url: string; tag: string; kind: "reminder" };

/** Notification shown by public/sw.js. Plain text, no emojis. */
export function reminderPayload(due: DueReminder): ReminderPayload {
  return {
    title: "Lift",
    body: due.kind === "snooze" ? "Snooze is over. Time to train." : "Gym day today. Your workout is ready when you are.",
    url: "/",
    tag: due.kind === "snooze" ? "lift-reminder" : `lift-reminder-${due.date}`,
    kind: "reminder",
  };
}
