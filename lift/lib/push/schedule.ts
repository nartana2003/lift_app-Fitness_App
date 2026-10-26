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
 * time zone (profiles.timezone); a bad zone falls back to UTC. Across DST
 * changes each date's reminder is one instant, resolved like the browser does
 * (zonedInstant), so it fires exactly once.
 */
import type { ReminderSettings } from "../reminders";

export type ServerReminder = Pick<ReminderSettings, "days" | "time" | "skipDate" | "snoozedUntil">;

/**
 * Default cron interval. /api/cron/reminders must be called hourly with
 * `Authorization: Bearer <CRON_SECRET>`, by Vercel Cron on a Pro plan or an
 * external scheduler (see lib/push/reminderJob.ts).
 */
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

const zoneCache = new Map<string, string>();
const formatterCache = new Map<string, Intl.DateTimeFormat>();
const MAX_CACHE = 500;

/** A usable IANA zone, else "UTC". Results are cached per input. */
export function safeTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return "UTC";
  const hit = zoneCache.get(tz);
  if (hit) return hit;
  let ok = "UTC";
  try {
    formatter(tz);
    ok = tz;
  } catch {
    ok = "UTC";
  }
  if (zoneCache.size >= MAX_CACHE) zoneCache.clear();
  zoneCache.set(tz, ok);
  return ok;
}

/** One cached formatter per zone (building Intl.DateTimeFormat is slow). Throws for a bad zone. */
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    if (formatterCache.size >= MAX_CACHE) formatterCache.clear();
    formatterCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock date, weekday (0 = Sunday) and minute of day of `t` in `tz`. */
export function localParts(t: Date, tz: string): { date: string; weekday: number; minutes: number } {
  const parts = formatter(safeTimeZone(tz)).formatToParts(t);
  let year = "", month = "", day = "", hour = "0", minute = "0", weekday = "Sun";
  for (const p of parts) {
    if (p.type === "year") year = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "day") day = p.value;
    else if (p.type === "hour") hour = p.value;
    else if (p.type === "minute") minute = p.value;
    else if (p.type === "weekday") weekday = p.value;
  }
  return { date: `${year}-${month}-${day}`, weekday: WEEKDAYS[weekday] ?? 0, minutes: Number(hour) * 60 + Number(minute) };
}

/** The zone's UTC offset at instant `ms`, in ms (wall clock minus UTC, to the minute). */
function offsetAt(ms: number, tz: string): number {
  const lp = localParts(new Date(ms), tz);
  const [y, m, d] = lp.date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d) + lp.minutes * 60_000;
  return wall - Math.floor(ms / 60_000) * 60_000;
}

/**
 * The instant of wall time `date` `minutes` in `tz`, resolved like the
 * browser's `new Date(y, m, d, hh, mm)` (what nextReminder uses): in the
 * fall-back overlap the earlier instant, in the spring-forward gap the time
 * moved forward by the gap (02:30 becomes 03:30).
 */
export function zonedInstant(date: string, minutes: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d) + minutes * 60_000;
  const before = offsetAt(asUtc - 12 * 3_600_000, tz);
  const after = offsetAt(asUtc + 12 * 3_600_000, tz);
  const fits = (t: number) => {
    const lp = localParts(new Date(t), tz);
    return lp.date === date && lp.minutes === minutes;
  };
  const candidates = [asUtc - before, asUtc - after].filter(fits);
  if (candidates.length) return Math.min(...candidates);
  return asUtc - before; // in the gap: same offset as before the jump, i.e. later wall time
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
  const today = localParts(now, tz).date;
  // Today's reminder, or yesterday's when the window crosses midnight. Each
  // date's reminder is one instant, so DST changes never fire it twice or skip it.
  for (const back of [0, 1]) {
    const date = shiftDate(today, -back);
    const at = zonedInstant(date, reminderMin, tz);
    if (nowMs - at < 0 || nowMs - at >= windowMs) continue;
    const [y, m, d] = date.split("-").map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (!r.days.includes(weekday) && !dates.has(date)) continue;
    if (date === r.skipDate) continue;
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
