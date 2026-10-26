/**
 * Server-only. GET /api/cron/reminders (Vercel Cron, hourly, see vercel.json):
 * sends the gym-day reminder push to every subscribed user whose reminder is
 * due (lib/push/schedule.ts). Subscriptions the push service reports gone
 * (404/410) are deleted.
 *
 * Order: CRON_SECRET bearer check (401) -> config check (503 unavailable when
 * VAPID or the service-role key is missing) -> load -> send. Data access is
 * behind ReminderStore so tests use an in-memory fake, never Supabase.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCronAuthorized } from "../cronAuth";
import { adminConfiguredFrom, toPushSub, vapidConfiguredFrom, type PushEnv, type PushSub } from "./endpoint";
import { DEFAULT_WINDOW_MIN, reminderDue, reminderPayload, shiftDate } from "./schedule";
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

export async function runReminderJob(
  store: ReminderStore,
  send: PushSender,
  now: Date = new Date(),
  windowMin: number = DEFAULT_WINDOW_MIN,
): Promise<ReminderJobResult> {
  const out: ReminderJobResult = { users: 0, due: 0, sent: 0, failed: 0, removed: 0 };
  const targets = await store.loadTargets(now);
  out.users = targets.length;
  let budget = MAX_SENDS_PER_RUN;
  for (const t of targets) {
    const due = reminderDue(t.reminders, t.gymDates, now, t.timezone, windowMin);
    if (!due) continue;
    out.due++;
    const payload = JSON.stringify(reminderPayload(due));
    for (const sub of t.subscriptions) {
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
        try {
          await store.removeSubscription(sub.endpoint);
          out.removed++;
        } catch {
          // left for the next run
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

export type ReminderCronDeps = {
  env: PushEnv;
  store: () => ReminderStore;
  send: () => PushSender;
  now?: () => Date;
};

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
    const result = await runReminderJob(deps.store(), deps.send(), deps.now?.() ?? new Date());
    return Response.json(result);
  } catch {
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
