"use client";

/**
 * Browser side of push reminders (Profile > Reminders > Enable notifications).
 * Needs Supabase, the VAPID public key, a service worker and PushManager
 * (iOS 16.4+ only once Lift is installed to the Home Screen). Without them
 * everything reports "unavailable" and the in-app schedule keeps working.
 */

import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseConfigured } from "@/lib/supabase/configured";
import { localDateKey, normalizeReminders, updateReminders, type ReminderSettings } from "@/lib/reminders";
import { urlBase64ToUint8Array } from "./endpoint";

export const SUBSCRIBE_URL = "/api/push/subscribe";

const vapidKey = () => process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

/** True when this browser and build can do Web Push. */
export function pushAvailable(): boolean {
  if (!supabaseConfigured || !vapidKey()) return false;
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** The ready service worker, or null after `ms` (it is only registered in production builds). */
async function registration(ms = 5000): Promise<ServiceWorkerRegistration | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type PushState = "unavailable" | "off" | "on" | "denied";

/** Whether this phone currently has notifications on. */
export async function currentPushState(): Promise<PushState> {
  if (!pushAvailable()) return "unavailable";
  if (Notification.permission === "denied") return "denied";
  const reg = await registration(1500);
  if (!reg) return "unavailable";
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

/** The browser's IANA time zone, for server-side reminder times. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

type Pauses = Pick<ReminderSettings, "skipDate" | "snoozedUntil">;

/**
 * Skip / Snooze to save, given this device's values and the server's
 * (profiles.reminders, which "Skip today" / "Snooze" on a notification
 * writes). An active local value wins. Otherwise the server's skipDate is
 * kept when it is today or later, and its snoozedUntil while it is still in
 * the future, unless it is what this device last saved (then the user
 * cleared it here on purpose).
 */
export function mergeServerPauses(local: Pauses, server: unknown, now: Date, lastSaved: Pauses | null): Pauses {
  const s = normalizeReminders(server);
  const skipLive = (d: string | null): d is string => !!d && d >= localDateKey(now);
  const snoozeLive = (t: string | null): t is string => !!t && Date.parse(t) > now.getTime();
  const keepSkip = !skipLive(local.skipDate) && skipLive(s.skipDate) && s.skipDate !== lastSaved?.skipDate;
  const keepSnooze = !snoozeLive(local.snoozedUntil) && snoozeLive(s.snoozedUntil) && s.snoozedUntil !== lastSaved?.snoozedUntil;
  return {
    skipDate: keepSkip ? s.skipDate : local.skipDate,
    snoozedUntil: keepSnooze ? s.snoozedUntil : local.snoozedUntil,
  };
}

// What this tab last saved to the profile, per user (see mergeServerPauses).
let lastSaved: (Pauses & { uid: string }) | null = null;

/**
 * Copies the reminder schedule to the signed-in user's profile so the
 * /api/cron/reminders job can use it. An active server-side skip or snooze
 * is kept and copied into this device's reminders. Returns true when saved.
 */
export async function syncReminderSettings(r: ReminderSettings): Promise<boolean> {
  if (!supabaseConfigured || (typeof navigator !== "undefined" && !navigator.onLine)) return false;
  try {
    const supabase = supabaseBrowser();
    const { data } = await supabase.auth.getSession();
    const uid = data.session?.user.id;
    if (!uid) return false;
    const read = await supabase.from("profiles").select("reminders").eq("id", uid).maybeSingle();
    if (read.error) return false; // never overwrite a skip or snooze we could not read
    const server = (read.data as { reminders?: unknown } | null)?.reminders ?? null;
    const pauses = mergeServerPauses(r, server, new Date(), lastSaved?.uid === uid ? lastSaved : null);
    const merged = { ...r, ...pauses };
    const { error } = await supabase.from("profiles").upsert({
      id: uid,
      reminders: merged,
      reminder_days: r.days,
      reminder_time: r.time,
      timezone: browserTimeZone(),
    });
    if (error) return false;
    lastSaved = { uid, ...pauses };
    if (pauses.skipDate !== r.skipDate || pauses.snoozedUntil !== r.snoozedUntil) {
      await updateReminders((cur) => ({ ...cur, ...pauses }));
    }
    return true;
  } catch {
    return false;
  }
}

export type EnableResult = "on" | "unavailable" | "denied" | "signin" | "error";

/** Asks permission, subscribes this phone and stores the subscription. */
export async function enablePush(r: ReminderSettings): Promise<EnableResult> {
  if (!pushAvailable()) return "unavailable";
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return "denied";
    const reg = await registration();
    if (!reg) return "unavailable";
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey()) }));
    const res = await fetch(SUBSCRIBE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    if (res.status === 401) return "signin";
    if (res.status === 503) return "unavailable";
    if (!res.ok) return "error";
    await syncReminderSettings(r);
    return "on";
  } catch {
    return "error";
  }
}

/** Unsubscribes this phone and removes it on the server. */
export async function disablePush(): Promise<boolean> {
  if (!pushAvailable()) return false;
  try {
    const reg = await registration(1500);
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return true;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await fetch(SUBSCRIBE_URL, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
