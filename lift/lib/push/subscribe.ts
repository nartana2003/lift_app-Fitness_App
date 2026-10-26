/**
 * Server-only. /api/push/subscribe: POST saves this phone's Web Push
 * subscription for the signed-in user, DELETE removes it.
 *
 * Order: config (503 {unavailable:true} without Supabase, the service-role key
 * or VAPID) -> sign-in (401 {error:"unauthorized"}, same resolver as the AI
 * routes, lib/ai/guard.ts) -> per-user rate limit (429) -> body with a byte cap
 * (400/413) -> strict validation, unknown keys rejected (400) -> store.
 *
 * Storage uses the service-role client because `endpoint` is unique across
 * users: when someone else signs in on the same phone, the old row (owned by
 * the previous user, invisible to RLS) has to be replaced.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiRateLimited, aiUnauthorized, createRateLimiter, supabaseConfiguredFrom, type AiUserResolver, type RateLimiter } from "../ai/guard";
import { invalidRequest, readJsonBody } from "../ai/request";
import { adminConfiguredFrom, isAllowedPushEndpoint, toPushSub, vapidConfiguredFrom, type PushEnv, type PushSub } from "./endpoint";

export const MAX_SUBSCRIBE_BYTES = 4096;

/** Phones kept per user; older subscriptions are dropped. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

export interface SubscriptionStore {
  save(userId: string, sub: PushSub): Promise<void>;
  remove(userId: string, endpoint: string): Promise<void>;
}

export type SubscribeDeps = {
  env: PushEnv;
  resolveUser: AiUserResolver;
  store: () => SubscriptionStore;
  limiter: RateLimiter;
};

/** Small limiter: subscribing is a rare, user-initiated action. */
export const createSubscribeLimiter = () => createRateLimiter([{ windowMs: 60_000, max: 10 }]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** POST body: PushSubscription.toJSON() — endpoint, keys and an optional expirationTime. */
export function parseSubscribeBody(v: unknown): PushSub | null {
  if (!isObj(v)) return null;
  if (Object.keys(v).some((k) => k !== "endpoint" && k !== "keys" && k !== "expirationTime")) return null;
  if (v.expirationTime !== undefined && v.expirationTime !== null && !(typeof v.expirationTime === "number" && Number.isFinite(v.expirationTime))) return null;
  return toPushSub({ endpoint: v.endpoint, keys: v.keys });
}

/** DELETE body: { endpoint }. */
export function parseUnsubscribeBody(v: unknown): string | null {
  if (!isObj(v) || Object.keys(v).some((k) => k !== "endpoint")) return null;
  return isAllowedPushEndpoint(v.endpoint) ? v.endpoint : null;
}

export async function handlePushSubscription(req: Request, deps: SubscribeDeps): Promise<Response> {
  const { env } = deps;
  if (!supabaseConfiguredFrom(env) || !adminConfiguredFrom(env) || !vapidConfiguredFrom(env)) {
    return Response.json({ unavailable: true }, { status: 503 });
  }
  let user: { id: string } | null;
  try {
    user = await deps.resolveUser();
  } catch {
    user = null;
  }
  if (!user || typeof user.id !== "string" || !user.id.trim()) return aiUnauthorized();
  const limited = deps.limiter.check(user.id);
  if (!limited.ok) return aiRateLimited(limited.retryAfterSec);

  const body = await readJsonBody(req, MAX_SUBSCRIBE_BYTES);
  if (!body.ok) return invalidRequest(body.status);

  try {
    if (req.method === "DELETE") {
      const endpoint = parseUnsubscribeBody(body.value);
      if (!endpoint) return invalidRequest();
      await deps.store().remove(user.id, endpoint);
    } else {
      const sub = parseSubscribeBody(body.value);
      if (!sub) return invalidRequest();
      await deps.store().save(user.id, sub);
    }
  } catch {
    return Response.json({ error: "failed" }, { status: 500 });
  }
  return Response.json({ ok: true });
}

/** SubscriptionStore on the service-role client. */
export function supabaseSubscriptionStore(admin: SupabaseClient): SubscriptionStore {
  return {
    async save(userId, sub) {
      const del = await admin.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      if (del.error) throw new Error("delete failed");
      const ins = await admin.from("push_subscriptions").insert({ user_id: userId, endpoint: sub.endpoint, keys: sub.keys });
      if (ins.error) throw new Error("insert failed");
      const { data } = await admin
        .from("push_subscriptions")
        .select("id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      const extra = ((data ?? []) as { id: string }[]).slice(MAX_SUBSCRIPTIONS_PER_USER).map((r) => r.id);
      if (extra.length) await admin.from("push_subscriptions").delete().in("id", extra);
    },
    async remove(userId, endpoint) {
      const { error } = await admin.from("push_subscriptions").delete().eq("endpoint", endpoint).eq("user_id", userId);
      if (error) throw new Error("delete failed");
    },
  };
}
