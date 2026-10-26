/**
 * Server-only half of the rest-timer push. See lib/restTimerPush.ts for the flow.
 * Imports lib/ai/guard (next/headers via lib/supabase/server): never import from client code.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiRateLimited, aiUnauthorized, createRateLimiter, supabaseConfiguredFrom, type AiUserResolver, type RateLimiter } from "./ai/guard";
import { invalidRequest, readJsonBody } from "./ai/request";
import { adminConfiguredFrom, isAllowedPushEndpoint, toPushSub, vapidConfiguredFrom, type PushEnv, type PushSub } from "./push/endpoint";
import type { PushSender } from "./push/send";
import { MAX_REST_DELAY_SEC, MAX_REST_TIMER_BYTES, MIN_REST_DELAY_SEC, REST_PUSH_PAYLOAD } from "./restTimerPush";

// ---------- Server ----------

export interface RestSubscriptionStore {
  /** The stored subscription for this user and endpoint, or null. */
  find(userId: string, endpoint: string): Promise<PushSub | null>;
  /** Drop a subscription the push service reports as gone. */
  remove(userId: string, endpoint: string): Promise<void>;
}

/** Pending delayed pushes, at most one per user and phone. */
export interface RestScheduler {
  /** Runs `task` after `delayMs`, replacing any pending task under `key`. Resolves when it ran or was cancelled. */
  schedule(key: string, delayMs: number, task: () => Promise<void>): Promise<void>;
  /** Cancels the pending task under `key`. True when one was pending. */
  cancel(key: string): boolean;
  pending(): number;
}

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Upper bound on pending pushes per instance. */
export const MAX_PENDING_REST_PUSHES = 5000;

export function createRestScheduler(timers: Timers = realTimers, maxPending = MAX_PENDING_REST_PUSHES): RestScheduler {
  const jobs = new Map<string, { handle: unknown; done: () => void }>();

  const drop = (key: string) => {
    const job = jobs.get(key);
    if (!job) return false;
    jobs.delete(key);
    timers.clear(job.handle);
    job.done();
    return true;
  };

  return {
    schedule(key, delayMs, task) {
      drop(key);
      while (jobs.size >= maxPending) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
      return new Promise<void>((resolve) => {
        const handle = timers.set(() => {
          if (jobs.get(key)?.handle !== handle) return resolve();
          jobs.delete(key);
          task().catch(() => undefined).finally(resolve);
        }, delayMs);
        jobs.set(key, { handle, done: resolve });
      });
    },
    cancel: drop,
    pending: () => jobs.size,
  };
}

export type RestTimerDeps = {
  env: PushEnv;
  resolveUser: AiUserResolver;
  store: () => RestSubscriptionStore;
  send: () => PushSender;
  limiter: RateLimiter;
  scheduler: RestScheduler;
  /** Keeps the function alive for the wait (next/server `after`). Tests await the promise themselves. */
  keepAlive: (p: Promise<void>) => void;
};

/** A set ticks a timer roughly every minute or two; the window is generous but bounded. */
export const createRestTimerLimiter = () =>
  createRateLimiter([
    { windowMs: 60_000, max: 30 },
    { windowMs: 24 * 60 * 60_000, max: 1000 },
  ]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export type RestTimerRequest = { endpoint: string; delaySec: number };

/** POST body: { endpoint, delaySec } with a whole number of seconds in range. */
export function parseRestTimerBody(v: unknown): RestTimerRequest | null {
  if (!isObj(v)) return null;
  if (Object.keys(v).some((k) => k !== "endpoint" && k !== "delaySec")) return null;
  if (!isAllowedPushEndpoint(v.endpoint)) return null;
  const d = v.delaySec;
  if (typeof d !== "number" || !Number.isInteger(d) || d < MIN_REST_DELAY_SEC || d > MAX_REST_DELAY_SEC) return null;
  return { endpoint: v.endpoint, delaySec: d };
}

/** DELETE body: { endpoint }. */
export function parseRestCancelBody(v: unknown): string | null {
  if (!isObj(v) || Object.keys(v).some((k) => k !== "endpoint")) return null;
  return isAllowedPushEndpoint(v.endpoint) ? v.endpoint : null;
}

const jobKey = (userId: string, endpoint: string) => `${userId}\n${endpoint}`;

export async function handleRestTimer(req: Request, deps: RestTimerDeps): Promise<Response> {
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
  const userId = user.id;
  const limited = deps.limiter.check(userId);
  if (!limited.ok) return aiRateLimited(limited.retryAfterSec);

  const body = await readJsonBody(req, MAX_REST_TIMER_BYTES);
  if (!body.ok) return invalidRequest(body.status);

  if (req.method === "DELETE") {
    const endpoint = parseRestCancelBody(body.value);
    if (!endpoint) return invalidRequest();
    return Response.json({ ok: true, cancelled: deps.scheduler.cancel(jobKey(userId, endpoint)) });
  }

  const parsed = parseRestTimerBody(body.value);
  if (!parsed) return invalidRequest();
  let sub: PushSub | null;
  try {
    sub = await deps.store().find(userId, parsed.endpoint);
  } catch {
    return Response.json({ error: "failed" }, { status: 500 });
  }
  if (!sub) return Response.json({ error: "not_subscribed" }, { status: 404 });

  const target = sub;
  const payload = JSON.stringify(REST_PUSH_PAYLOAD);
  const done = deps.scheduler.schedule(jobKey(userId, target.endpoint), parsed.delaySec * 1000, async () => {
    const res = await deps.send()(target, payload);
    if (!res.ok && res.gone) await deps.store().remove(userId, target.endpoint);
  });
  deps.keepAlive(done);
  return Response.json({ ok: true, delaySec: parsed.delaySec });
}

/** RestSubscriptionStore on the service-role client, always scoped to the user. */
export function supabaseRestSubscriptionStore(admin: SupabaseClient): RestSubscriptionStore {
  return {
    async find(userId, endpoint) {
      const { data, error } = await admin
        .from("push_subscriptions")
        .select("endpoint, keys")
        .eq("user_id", userId)
        .eq("endpoint", endpoint)
        .maybeSingle();
      if (error) throw new Error("lookup failed");
      return data ? toPushSub(data) : null;
    },
    async remove(userId, endpoint) {
      await admin.from("push_subscriptions").delete().eq("endpoint", endpoint).eq("user_id", userId);
    },
  };
}
