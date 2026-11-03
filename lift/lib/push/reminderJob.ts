/**
 * Server-only. GET /api/cron/reminders, called HOURLY with the header
 * `Authorization: Bearer <CRON_SECRET>`. There is no vercel.json in the repo:
 * Vercel Hobby (free) only allows daily crons and rejects an hourly one at
 * deploy time. Pick one of:
 * - Vercel Cron on a Pro plan: add lift/vercel.json with
 *     { "crons": [{ "path": "/api/cron/reminders", "schedule": "0 * * * *" }] }
 *   (Vercel sends the Bearer CRON_SECRET header itself);
 * - an external scheduler hitting https://<app>/api/cron/reminders every hour
 *   with that header: Supabase pg_cron + pg_net (net.http_get with the
 *   Authorization header), or a free cron service.
 * A daily call would send most reminders late or not at all (the due window is
 * DEFAULT_WINDOW_MIN = 60 minutes).
 *
 * What it does:
 * sends the gym-day reminder push to every subscribed user whose reminder is
 * due (lib/push/schedule.ts). Subscriptions the push service reports gone
 * (404/410) are deleted. With `extras` (the route wires them) it also sends
 * the "haven't gone yet" and "behind on weekly goal" nudges (lib/push/nudges.ts)
 * and puts signed Skip today / Snooze buttons on planned-day pushes
 * (lib/push/reminderAction.ts).
 *
 * Order: CRON_SECRET bearer check (401) -> config check (503 unavailable when
 * VAPID or the service-role key is missing) -> load -> send. Data access is
 * behind ReminderStore so tests use an in-memory fake, never Supabase.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCronAuthorized } from "../cronAuth";
import { adminConfiguredFrom, toPushSub, vapidConfiguredFrom, type PushEnv, type PushSub } from "./endpoint";
import { behindDue, normalizeNudgeReminder, notYetDue, nudgePayload, reminderActions, type NudgeData } from "./nudges";
import { signActionToken } from "./reminderAction";
import { DEFAULT_WINDOW_MIN, localParts, reminderDue, reminderPayload, safeTimeZone, shiftDate } from "./schedule";
import type { PushSender } from "./send";

export type ReminderTarget = {
  userId: string;
  timezone: string;
  /** profiles.reminders (jsonb), normalised by reminderDue. */
  reminders: unknown;
  /** planned_days dates with status "planned" around today. */
  gymDates: string[];
  subscriptions: PushSub[];
};

export interface ReminderStore {
  loadTargets(now: Date): Promise<ReminderTarget[]>;
  removeSubscription(endpoint: string): Promise<void>;
}

export type ReminderJobResult = { users: number; due: number; sent: number; failed: number; removed: number };

/** Cap on pushes in one run, so a bad row set cannot fan out without limit. */
export const MAX_SENDS_PER_RUN = 5000;

/** Loads the nudge inputs (workout starts, this week's sets, targets) per user. */
export interface NudgeStore {
  loadNudgeData(userIds: string[], now: Date): Promise<Map<string, NudgeData>>;
}

/** Optional parts of the job; without them only the gym-day reminder is sent, with no buttons. */
export type ReminderJobExtras = {
  nudges?: NudgeStore;
  /** Primary muscle groups of an exercise id (for the "behind" nudge). */
  muscleOf?: (exerciseId: string) => readonly string[];
  /** Signs a Skip / Snooze token for a user and local date. */
  signAction?: (userId: string, date: string) => string;
};

export async function runReminderJob(
  store: ReminderStore,
  send: PushSender,
  now: Date = new Date(),
  windowMin: number = DEFAULT_WINDOW_MIN,
  extras: ReminderJobExtras = {},
): Promise<ReminderJobResult> {
  const out: ReminderJobResult = { users: 0, due: 0, sent: 0, failed: 0, removed: 0 };
  const targets = await store.loadTargets(now);
  out.users = targets.length;
  let nudgeData = new Map<string, NudgeData>();
  if (extras.nudges && targets.length) {
    try {
      nudgeData = await extras.nudges.loadNudgeData(targets.map((t) => t.userId), now);
    } catch {
      // nudges are extra: the gym reminders still go out
    }
  }
  let budget = MAX_SENDS_PER_RUN;
  for (const t of targets) {
    const payloads: string[] = [];
    const withActions = (p: object, date: string) => {
      if (!extras.signAction) return p;
      return { ...p, actions: reminderActions(normalizeNudgeReminder(t.reminders).snoozeMin), token: extras.signAction(t.userId, date) };
    };
    const due = reminderDue(t.reminders, t.gymDates, now, t.timezone, windowMin);
    if (due) {
      const date = due.kind === "gym" ? due.date : localParts(now, safeTimeZone(t.timezone)).date;
      payloads.push(JSON.stringify(withActions(reminderPayload(due), date)));
    }
    const data = nudgeData.get(t.userId);
    if (data) {
      const notYet = notYetDue(t.reminders, t.gymDates, data, now, t.timezone, windowMin);
      if (notYet) payloads.push(JSON.stringify(withActions(nudgePayload(notYet), notYet.date)));
      const behind = extras.muscleOf ? behindDue(t.reminders, data, extras.muscleOf, now, t.timezone, windowMin) : null;
      if (behind) payloads.push(JSON.stringify(nudgePayload(behind)));
    }
    out.due += payloads.length;
    const gone = new Set<string>();
    for (const payload of payloads) {
      for (const sub of t.subscriptions) {
        if (gone.has(sub.endpoint)) continue;
        if (budget-- <= 0) return out;
        let res;
        try {
          res = await send(sub, payload);
        } catch {
          res = { ok: false as const, gone: false };
        }
        if (res.ok) {
          out.sent++;
          continue;
        }
        out.failed++;
        if (res.gone) {
          gone.add(sub.endpoint);
          try {
            await store.removeSubscription(sub.endpoint);
            out.removed++;
          } catch {
            // left for the next run
          }
        }
      }
    }
  }
  return out;
}

const MAX_ROWS = 5000;

/** ReminderStore backed by the service-role Supabase client (bypasses RLS; server only). */
export function supabaseReminderStore(admin: SupabaseClient): ReminderStore {
  return {
    async loadTargets(now) {
      const { data: subs, error } = await admin.from("push_subscriptions").select("user_id, endpoint, keys").limit(MAX_ROWS);
      if (error || !Array.isArray(subs)) throw new Error("push_subscriptions unavailable");
      const byUser = new Map<string, PushSub[]>();
      for (const s of subs as { user_id: unknown; endpoint: unknown; keys: unknown }[]) {
        const sub = toPushSub({ endpoint: s.endpoint, keys: s.keys });
        if (!sub || typeof s.user_id !== "string") continue;
        byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), sub]);
      }
      const ids = [...byUser.keys()];
      if (!ids.length) return [];

      const { data: profiles } = await admin.from("profiles").select("id, timezone, reminders").in("id", ids);
      // Any time zone's "today" is within a day of UTC's, so this range covers yesterday..tomorrow everywhere.
      const utc = now.toISOString().slice(0, 10);
      const { data: planned } = await admin
        .from("planned_days")
        .select("user_id, date")
        .in("user_id", ids)
        .eq("status", "planned")
        .gte("date", shiftDate(utc, -2))
        .lte("date", shiftDate(utc, 2))
        .limit(MAX_ROWS);

      const prof = new Map<string, { timezone: unknown; reminders: unknown }>();
      for (const p of (profiles ?? []) as { id: string; timezone: unknown; reminders: unknown }[]) prof.set(p.id, p);
      const dates = new Map<string, string[]>();
      for (const d of (planned ?? []) as { user_id: string; date: unknown }[]) {
        if (typeof d.date === "string") dates.set(d.user_id, [...(dates.get(d.user_id) ?? []), d.date.slice(0, 10)]);
      }
      return ids.map((userId) => ({
        userId,
        timezone: typeof prof.get(userId)?.timezone === "string" ? (prof.get(userId)!.timezone as string) : "UTC",
        reminders: prof.get(userId)?.reminders ?? null,
        gymDates: dates.get(userId) ?? [],
        subscriptions: byUser.get(userId)!,
      }));
    },
    async removeSubscription(endpoint) {
      const { error } = await admin.from("push_subscriptions").delete().eq("endpoint", endpoint);
      if (error) throw new Error("delete failed");
    },
  };
}

/** Days of workout start times loaded for the usual training time. */
export const NUDGE_HISTORY_DAYS = 60;

/** NudgeStore backed by the service-role Supabase client (server only). */
export function supabaseNudgeStore(admin: SupabaseClient): NudgeStore {
  return {
    async loadNudgeData(userIds, now) {
      const out = new Map<string, NudgeData>();
      for (const id of userIds) out.set(id, { workoutStarts: [], weekSets: [], targets: {} });
      if (!userIds.length) return out;
      const since = new Date(now.getTime() - NUDGE_HISTORY_DAYS * 864e5).toISOString();
      const weekSince = now.getTime() - 8 * 864e5;
      const { data: workouts, error } = await admin
        .from("workouts")
        .select("id, user_id, started_at")
        .in("user_id", userIds)
        .gte("started_at", since)
        .order("started_at", { ascending: false })
        .limit(MAX_ROWS);
      if (error) throw new Error("workouts unavailable");
      const startOf = new Map<string, { user: string; started_at: string }>();
      for (const w of (workouts ?? []) as { id: unknown; user_id: unknown; started_at: unknown }[]) {
        if (typeof w.id !== "string" || typeof w.user_id !== "string" || typeof w.started_at !== "string") continue;
        const d = out.get(w.user_id);
        if (!d) continue;
        d.workoutStarts.push(w.started_at);
        if (Date.parse(w.started_at) >= weekSince) startOf.set(w.id, { user: w.user_id, started_at: w.started_at });
      }

      const { data: targets } = await admin.from("muscle_targets").select("user_id, muscle_group, weekly_sets").in("user_id", userIds).limit(MAX_ROWS);
      for (const t of (targets ?? []) as { user_id: unknown; muscle_group: unknown; weekly_sets: unknown }[]) {
        const d = typeof t.user_id === "string" ? out.get(t.user_id) : undefined;
        if (d && typeof t.muscle_group === "string" && typeof t.weekly_sets === "number") d.targets[t.muscle_group] = t.weekly_sets;
      }

      const weekIds = [...startOf.keys()];
      if (!weekIds.length) return out;
      const { data: wes } = await admin.from("workout_exercises").select("id, workout_id, exercise_id").in("workout_id", weekIds).limit(MAX_ROWS);
      const exOf = new Map<string, { user: string; started_at: string; exercise_id: string }>();
      for (const we of (wes ?? []) as { id: unknown; workout_id: unknown; exercise_id: unknown }[]) {
        const w = typeof we.workout_id === "string" ? startOf.get(we.workout_id) : undefined;
        if (!w || typeof we.id !== "string" || typeof we.exercise_id !== "string") continue;
        exOf.set(we.id, { ...w, exercise_id: we.exercise_id });
      }
      if (!exOf.size) return out;
      const { data: sets } = await admin.from("sets").select("workout_exercise_id, is_warmup").in("workout_exercise_id", [...exOf.keys()]).limit(MAX_ROWS);
      for (const s of (sets ?? []) as { workout_exercise_id: unknown; is_warmup: unknown }[]) {
        const e = typeof s.workout_exercise_id === "string" ? exOf.get(s.workout_exercise_id) : undefined;
        if (!e) continue;
        out.get(e.user)?.weekSets.push({ started_at: e.started_at, exercise_id: e.exercise_id, is_warmup: s.is_warmup === true });
      }
      return out;
    },
  };
}

export type ReminderCronDeps = {
  env: PushEnv;
  store: () => ReminderStore;
  send: () => PushSender;
  now?: () => Date;
  /** Nudges and notification buttons; see ReminderJobExtras. */
  extras?: () => ReminderJobExtras;
};

/** Token signer for the Skip / Snooze buttons, keyed by CRON_SECRET. */
export const actionSigner =
  (secret: string, now: Date) =>
  (userId: string, date: string): string =>
    signActionToken(userId, date, secret, now);

/** Full route handler; the route file only wires the real dependencies. */
export async function handleReminderCron(req: Request, deps: ReminderCronDeps): Promise<Response> {
  // middleware.ts checks this too; the route checks again (lib/cronAuth.ts).
  if (!isCronAuthorized(req.headers.get("authorization"), deps.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!vapidConfiguredFrom(deps.env) || !adminConfiguredFrom(deps.env)) {
    return Response.json({ unavailable: true }, { status: 503 });
  }
  try {
    const result = await runReminderJob(deps.store(), deps.send(), deps.now?.() ?? new Date(), DEFAULT_WINDOW_MIN, deps.extras?.() ?? {});
    return Response.json(result);
  } catch {
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
