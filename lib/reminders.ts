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

/**
 * Pure: when the next reminder is due after `now`, or null when no gym days are
 * picked. Today's reminders are dropped if today is skipped; a snooze moves
 * the reminder to the end of the snooze.
 */
export function nextReminder(r: ReminderSettings, now: Date): Date | null {
  if (r.days.length === 0 || !isValidTime(r.time)) return null;
  const [hh, mm] = r.time.split(":").map(Number);
  const snooze = r.snoozedUntil ? new Date(r.snoozedUntil) : null;
  const snoozeActive = snooze && snooze.getTime() > now.getTime() && localDateKey(snooze) !== r.skipDate ? snooze : null;

  let best: Date | null = null;
  for (let i = 0; i <= 7 && !best; i++) {
    const c = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hh, mm, 0, 0);
    if (!r.days.includes(c.getDay())) continue;
    if (c.getTime() <= now.getTime()) continue;
    if (localDateKey(c) === r.skipDate) continue;
    // A reminder on the snoozed day that falls before the snooze ends is replaced by it.
    if (snoozeActive && localDateKey(c) === localDateKey(snoozeActive) && c.getTime() <= snoozeActive.getTime()) continue;
    best = c;
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

/** Live saved reminder settings for components. */
export function useReminders(): ReminderSettings {
  return useLiveQuery(getReminders, [], DEFAULT_REMINDERS);
}
