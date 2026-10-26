"use client";

/**
 * Reminder settings (Profile → Reminders): which days and at what time to be
 * nudged, plus the "you're behind" and smart-reminder switches and the
 * Skip today / Snooze choices. Saved on this device in Dexie meta (so it is
 * part of backups).
 *
 * Real push delivery needs a push subscription stored on the server and an
 * hourly cron job, which are not set up yet. Everything here is local only;
 * the pure helpers (nextReminder, reminderSummary) are what the server-side
 * job can reuse later.
 */

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./offline/db";

export const REMINDERS_KEY = "reminders";

/** Snooze lengths offered in the UI, in minutes. */
export const SNOOZE_OPTIONS = [15, 30, 60, 120] as const;
export type SnoozeMin = (typeof SNOOZE_OPTIONS)[number];

export type ReminderSettings = {
  /** Gym days as JS weekdays: 0 = Sunday … 6 = Saturday. Sorted, unique. */
  days: number[];
  /** Local reminder time, 24h "HH:MM". */
  time: string;
  /** Send a "you're behind" nudge if weekly sessions are under goal by Thursday. */
  behindNudge: boolean;
  /** Learn the usual training time and nudge an hour after it on planned days. */
  smart: boolean;
  /** How long "Snooze" pushes a reminder back. */
  snoozeMin: SnoozeMin;
  /** Local date "YYYY-MM-DD" whose reminders are skipped, or null. */
  skipDate: string | null;
  /** ISO time the current snooze ends, or null. */
  snoozedUntil: string | null;
};

export const DEFAULT_REMINDERS: ReminderSettings = {
  days: [],
  time: "18:00",
  behindNudge: true,
  smart: false,
  snoozeMin: 60,
  skipDate: null,
  snoozedUntil: null,
};

export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pure: true for a 24h "HH:MM" time. */
export function isValidTime(t: unknown): t is string {
  return typeof t === "string" && TIME_RE.test(t);
}

const isDay = (d: unknown): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6;

/** Pure: turns whatever is stored into clean settings. Bad fields fall back to defaults. */
export function normalizeReminders(raw: unknown): ReminderSettings {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const days = Array.isArray(r.days) ? [...new Set(r.days.filter(isDay))].sort((a, b) => a - b) : [];
  const snoozedUntil =
    typeof r.snoozedUntil === "string" && !Number.isNaN(Date.parse(r.snoozedUntil)) ? r.snoozedUntil : null;
  return {
    days,
    time: isValidTime(r.time) ? r.time : DEFAULT_REMINDERS.time,
    behindNudge: typeof r.behindNudge === "boolean" ? r.behindNudge : DEFAULT_REMINDERS.behindNudge,
    smart: typeof r.smart === "boolean" ? r.smart : DEFAULT_REMINDERS.smart,
    snoozeMin: (SNOOZE_OPTIONS as readonly unknown[]).includes(r.snoozeMin) ? (r.snoozeMin as SnoozeMin) : DEFAULT_REMINDERS.snoozeMin,
    skipDate: typeof r.skipDate === "string" && DATE_RE.test(r.skipDate) ? r.skipDate : null,
    snoozedUntil,
  };
}

/** Pure: adds or removes one gym day, keeping the list sorted. */
export function toggleDayIn(days: readonly number[], day: number): number[] {
  if (!isDay(day)) return [...days];
  const set = new Set(days.filter(isDay));
  if (set.has(day)) set.delete(day);
  else set.add(day);
  return [...set].sort((a, b) => a - b);
}

/** Pure: the seven weekdays in display order for the given week start. */
export function orderedDays(weekStart: 0 | 1): number[] {
  return weekStart === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
}

/** Pure: local calendar date key "YYYY-MM-DD". */
export function localDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Pure: short summary for the Profile row, e.g. "Mon, Wed, Fri at 18:00" or "Off". */
export function reminderSummary(r: ReminderSettings, weekStart: 0 | 1 = 1): string {
  if (r.days.length === 0) return "Off";
  const names = orderedDays(weekStart).filter((d) => r.days.includes(d)).map((d) => DAY_SHORT[d]);
  return `${r.days.length === 7 ? "Every day" : names.join(", ")} at ${r.time}`;
}

/** Pure: true for a real local calendar date "YYYY-MM-DD" (rejects 2026-02-30). */
function isCalendarDate(d: unknown): d is string {
  if (typeof d !== "string" || !DATE_RE.test(d)) return false;
  const [y, m, day] = d.split("-").map(Number);
  return localDateKey(new Date(y, m - 1, day)) === d;
}

/**
 * Pure: when the next reminder is due after `now`, or null when no gym days are
 * picked. Today's reminders are dropped if today is skipped; a snooze moves
 * the reminder to the end of the snooze.
 *
 * `gymDates` (optional) are the dates marked as gym days on the This Week strip
 * ("YYYY-MM-DD"). Each one gets a reminder at the reminder time, alongside any
 * usual weekdays in `r.days`; the earliest one still ahead of `now` wins. With
 * no dates (or an empty list) this is the weekday-only schedule.
 */
export function nextReminder(r: ReminderSettings, now: Date, gymDates?: readonly string[]): Date | null {
  const dates = (gymDates ?? []).filter(isCalendarDate);
  if ((r.days.length === 0 && dates.length === 0) || !isValidTime(r.time)) return null;
  const [hh, mm] = r.time.split(":").map(Number);
  const snooze = r.snoozedUntil ? new Date(r.snoozedUntil) : null;
  const snoozeActive = snooze && snooze.getTime() > now.getTime() && localDateKey(snooze) !== r.skipDate ? snooze : null;

  const usable = (c: Date) => {
    if (c.getTime() <= now.getTime()) return false;
    if (localDateKey(c) === r.skipDate) return false;
    // A reminder on the snoozed day that falls before the snooze ends is replaced by it.
    if (snoozeActive && localDateKey(c) === localDateKey(snoozeActive) && c.getTime() <= snoozeActive.getTime()) return false;
    return true;
  };

  let best: Date | null = null;
  for (let i = 0; i <= 7 && !best && r.days.length > 0; i++) {
    const c = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hh, mm, 0, 0);
    if (!r.days.includes(c.getDay())) continue;
    if (!usable(c)) continue;
    best = c;
  }
  for (const d of dates) {
    const [y, m, day] = d.split("-").map(Number);
    const c = new Date(y, m - 1, day, hh, mm, 0, 0);
    if (!usable(c)) continue;
    if (!best || c.getTime() < best.getTime()) best = c;
  }
  if (snoozeActive && (!best || snoozeActive.getTime() < best.getTime())) return snoozeActive;
  return best;
}

/** Pure: "Today 18:00", "Tomorrow 18:00" or "Mon 18:00" for the next-reminder line. */
export function formatNext(next: Date, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const time = `${p(next.getHours())}:${p(next.getMinutes())}`;
  const today = localDateKey(now);
  const tomorrow = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const key = localDateKey(next);
  const day = key === today ? "Today" : key === tomorrow ? "Tomorrow" : DAY_SHORT[next.getDay()];
  return `${day} ${time}`;
}

/** Pure: skip (or un-skip) today's reminders. Skipping also clears any snooze. */
export function toggleSkipToday(r: ReminderSettings, now: Date): ReminderSettings {
  const today = localDateKey(now);
  return r.skipDate === today ? { ...r, skipDate: null } : { ...r, skipDate: today, snoozedUntil: null };
}

/** Pure: snooze for `snoozeMin` from now, or cancel an active snooze. */
export function toggleSnooze(r: ReminderSettings, now: Date): ReminderSettings {
  if (isSnoozed(r, now)) return { ...r, snoozedUntil: null };
  return { ...r, snoozedUntil: new Date(now.getTime() + r.snoozeMin * 60_000).toISOString(), skipDate: r.skipDate === localDateKey(now) ? null : r.skipDate };
}

export const isSkippedToday = (r: ReminderSettings, now: Date) => r.skipDate === localDateKey(now);
export const isSnoozed = (r: ReminderSettings, now: Date) => !!r.snoozedUntil && Date.parse(r.snoozedUntil) > now.getTime();

/** Smart reminder time: fewest workouts needed before a usual start time is suggested. */
export const SMART_MIN_WORKOUTS = 5;
/** Smart reminder time: how many of the most recent workouts are looked at. */
export const SMART_RECENT_WORKOUTS = 20;

/**
 * Smart reminder time: the training "day" starts at 04:00 local. Starts before
 * it count as late the previous evening, so 23:50 and 00:10 average to
 * midnight instead of midday. Starts from 04:00 on are unaffected.
 */
export const SMART_DAY_START_MIN = 4 * 60;

/** ISO-like date-time ("YYYY-MM-DDTHH:MM..."): rejects strings like "1" that Date.parse accepts. */
const ISO_START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Pure: the user's usual workout start time as local "HH:MM", or null when
 * there are fewer than `min` usable start times. Takes the `recent` most
 * recent valid start times (ISO strings, any order; junk is ignored) and
 * returns the median local time of day, rounded to the nearest minute (the
 * mean of the two middle values for an even count). Times before 04:00 are
 * treated as following 23:59 (midnight wrap, see SMART_DAY_START_MIN).
 * With `now`, starts after `now` are ignored.
 */
export function usualStartTime(
  startedAts: readonly string[],
  opts: { min?: number; recent?: number; now?: Date } = {},
): string | null {
  const min = Math.max(1, opts.min ?? SMART_MIN_WORKOUTS);
  const recent = Math.max(min, opts.recent ?? SMART_RECENT_WORKOUTS);
  const nowMs = opts.now ? opts.now.getTime() : Number.POSITIVE_INFINITY;
  const times = startedAts
    .filter((s): s is string => typeof s === "string" && ISO_START_RE.test(s))
    .map((s) => Date.parse(s))
    .filter((t) => !Number.isNaN(t) && t <= nowMs)
    .sort((a, b) => b - a)
    .slice(0, recent);
  if (times.length < min) return null;
  const minutes = times
    .map((t) => {
      const d = new Date(t);
      const m = d.getHours() * 60 + d.getMinutes();
      return m < SMART_DAY_START_MIN ? m + 24 * 60 : m;
    })
    .sort((a, b) => a - b);
  const mid = Math.floor(minutes.length / 2);
  const median = minutes.length % 2 ? minutes[mid] : (minutes[mid - 1] + minutes[mid]) / 2;
  const total = Math.round(median) % (24 * 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(total / 60))}:${p(total % 60)}`;
}

/**
 * Pure: the learned start time to offer as the reminder time, or null when
 * there is not enough history or it already matches the saved time. Never
 * changes the settings; the UI saves it only when the user taps it.
 */
export function suggestedReminderTime(r: ReminderSettings, startedAts: readonly string[], now?: Date): string | null {
  const usual = usualStartTime(startedAts, { now });
  return usual && usual !== r.time ? usual : null;
}

/** Start times of the most recent workouts, newest first. */
export async function getRecentWorkoutStarts(limit = SMART_RECENT_WORKOUTS): Promise<string[]> {
  const rows = await db.workouts.orderBy("started_at").reverse().limit(limit).toArray();
  return rows.map((w) => w.started_at);
}

/** Live start times of the most recent workouts (empty while loading). */
export function useRecentWorkoutStarts(limit = SMART_RECENT_WORKOUTS): string[] {
  return useLiveQuery(() => getRecentWorkoutStarts(limit), [limit], [] as string[]);
}

/** Saved reminder settings (defaults until the user changes them). */
export async function getReminders(): Promise<ReminderSettings> {
  return normalizeReminders((await db.meta.get(REMINDERS_KEY))?.value);
}

export async function saveReminders(r: ReminderSettings): Promise<ReminderSettings> {
  const clean = normalizeReminders(r);
  await db.meta.put({ key: REMINDERS_KEY, value: clean });
  return clean;
}

/** Reads, changes and saves in one transaction. */
export async function updateReminders(fn: (r: ReminderSettings) => ReminderSettings): Promise<ReminderSettings> {
  return db.transaction("rw", db.meta, async () => saveReminders(fn(await getReminders())));
}

/**
 * Dates marked as gym days on the This Week strip (planned_days rows with
 * status "planned") from `today` on, sorted. Done, skipped and moved days are
 * left out.
 */
export async function getMarkedGymDates(today: string): Promise<string[]> {
  const rows = await db.planned_days.where("date").aboveOrEqual(today).toArray();
  return rows.filter((d) => d.status === "planned").map((d) => d.date).sort();
}

/** Live marked gym dates from today on (empty while loading). */
export function useMarkedGymDates(today: string): string[] {
  return useLiveQuery(() => getMarkedGymDates(today), [today], [] as string[]);
}

/** Live saved reminder settings for components. */
export function useReminders(): ReminderSettings {
  return useLiveQuery(getReminders, [], DEFAULT_REMINDERS);
}
