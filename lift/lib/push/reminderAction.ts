/**
 * Server-only. POST /api/push/action: the Skip today and Snooze buttons on a
 * reminder notification. public/sw.js posts { action, token } when one is
 * tapped; the token was signed by the cron job (lib/push/reminderJob.ts) for
 * that user and date, so the service worker needs no sign-in.
 *
 * - skip: profiles.reminders.skipDate = that date (and any snooze ends), and
 *   that date's planned_days row (status "planned") becomes "skipped", so the
 *   This Week strip shows it after the next sync pull.
 * - snooze: profiles.reminders.snoozedUntil = now + snoozeMin; the cron job
 *   sends the "Snooze is over" push when it ends.
 * Same rules as toggleSkipToday / toggleSnooze in lib/reminders.ts, but they
 * always set (a repeated tap is harmless) and never toggle off.
 *
 * Order: config (503 without CRON_SECRET or the service-role key) -> body with
 * a byte cap (400/413) -> strict validation, unknown keys rejected (400) ->
 * token check (401) -> per-user rate limit (429) -> store.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiRateLimited, aiUnauthorized, createRateLimiter, type RateLimiter } from "../ai/guard";
import { invalidRequest, readJsonBody } from "../ai/request";
import { adminConfiguredFrom, type PushEnv } from "./endpoint";
import { normalizeNudgeReminder } from "./nudges";

export const ACTION_URL = "/api/push/action";
export const MAX_ACTION_BYTES = 2048;
export const MAX_TOKEN_LENGTH = 512;
/** A notification's buttons work for a day. */
export const ACTION_TOKEN_TTL_MS = 24 * 60 * 60_000;

export type ReminderAction = "skip" | "snooze";
export type ActionClaims = { u: string; d: string; e: number };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USER_RE = /^[A-Za-z0-9-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (body: string, secret: string) => createHmac("sha256", secret).update(`reminder-action:${body}`).digest();

/** Signs a token for user `userId` and local date `date`, valid until `now` + ACTION_TOKEN_TTL_MS. */
export function signActionToken(userId: string, date: string, secret: string, now: Date = new Date()): string {
  const body = b64url(JSON.stringify({ u: userId, d: date, e: now.getTime() + ACTION_TOKEN_TTL_MS }));
  return `${body}.${b64url(mac(body, secret))}`;
}

/** The claims of a valid, unexpired token, else null. */
export function verifyActionToken(token: unknown, secret: string | undefined, now: Date = new Date()): ActionClaims | null {
  if (!secret || typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  const sig = Buffer.from(parts[1], "base64url");
  const want = mac(parts[0], secret);
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  let c: unknown;
  try {
    c = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isObj(c) || Object.keys(c).some((k) => k !== "u" && k !== "d" && k !== "e")) return null;
  if (typeof c.u !== "string" || !USER_RE.test(c.u)) return null;
  if (typeof c.d !== "string" || !DATE_RE.test(c.d)) return null;
  if (typeof c.e !== "number" || !Number.isFinite(c.e) || c.e <= now.getTime()) return null;
  return { u: c.u, d: c.d, e: c.e };
}

/** POST body: { action: "skip" | "snooze", token }. */
export function parseActionBody(v: unknown): { action: ReminderAction; token: string } | null {
  if (!isObj(v) || Object.keys(v).some((k) => k !== "action" && k !== "token")) return null;
  if (v.action !== "skip" && v.action !== "snooze") return null;
  if (typeof v.token !== "string" || v.token.length === 0 || v.token.length > MAX_TOKEN_LENGTH) return null;
  return { action: v.action, token: v.token };
}

/**
 * The stored reminders (profiles.reminders) after the action. Other stored
 * fields are kept as they are.
 */
export function applyReminderAction(raw: unknown, action: ReminderAction, date: string, now: Date): Record<string, unknown> {
  const base = isObj(raw) ? { ...raw } : {};
  if (action === "skip") return { ...base, skipDate: date, snoozedUntil: null };
  const r = normalizeNudgeReminder(raw);
  return {
    ...base,
    snoozedUntil: new Date(now.getTime() + r.snoozeMin * 60_000).toISOString(),
    skipDate: r.skipDate === date ? null : r.skipDate,
  };
}

export interface ReminderActionStore {
  getReminders(userId: string): Promise<unknown>;
  saveReminders(userId: string, reminders: Record<string, unknown>): Promise<void>;
  /** Marks that date's planned day (status "planned") as skipped. */
  skipPlannedDay(userId: string, date: string): Promise<void>;
}

export type ReminderActionDeps = {
  env: PushEnv;
  store: () => ReminderActionStore;
  limiter: RateLimiter;
  now?: () => Date;
};

export const createActionLimiter = () => createRateLimiter([{ windowMs: 60_000, max: 10 }]);

export async function handleReminderAction(req: Request, deps: ReminderActionDeps): Promise<Response> {
  const secret = deps.env.CRON_SECRET;
  if (!secret || !adminConfiguredFrom(deps.env)) return Response.json({ unavailable: true }, { status: 503 });
  const body = await readJsonBody(req, MAX_ACTION_BYTES);
  if (!body.ok) return invalidRequest(body.status);
  const parsed = parseActionBody(body.value);
  if (!parsed) return invalidRequest();
  const now = deps.now?.() ?? new Date();
  const claims = verifyActionToken(parsed.token, secret, now);
  if (!claims) return aiUnauthorized();
  const limited = deps.limiter.check(claims.u);
  if (!limited.ok) return aiRateLimited(limited.retryAfterSec);
  try {
    const store = deps.store();
    const next = applyReminderAction(await store.getReminders(claims.u), parsed.action, claims.d, now);
    await store.saveReminders(claims.u, next);
    if (parsed.action === "skip") await store.skipPlannedDay(claims.u, claims.d);
  } catch {
    return Response.json({ error: "failed" }, { status: 500 });
  }
  return Response.json({ ok: true, action: parsed.action });
}

/** ReminderActionStore on the service-role client (server only). */
export function supabaseReminderActionStore(admin: SupabaseClient): ReminderActionStore {
  return {
    async getReminders(userId) {
      const { data, error } = await admin.from("profiles").select("reminders").eq("id", userId).maybeSingle();
      if (error) throw new Error("profile unavailable");
      return (data as { reminders?: unknown } | null)?.reminders ?? null;
    },
    async saveReminders(userId, reminders) {
      const { error } = await admin.from("profiles").update({ reminders }).eq("id", userId);
      if (error) throw new Error("profile update failed");
    },
    async skipPlannedDay(userId, date) {
      const { error } = await admin
        .from("planned_days")
        .update({ status: "skipped" })
        .eq("user_id", userId)
        .eq("date", date)
        .eq("status", "planned");
      if (error) throw new Error("planned day update failed");
    },
  };
}
