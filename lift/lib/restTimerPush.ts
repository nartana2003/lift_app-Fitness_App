/**
 * Rest-timer push (PLAN.md line 97): when the rest timer is running and Lift
 * goes to the background or the phone locks, the app asks /api/rest-timer to
 * send this phone a short delayed push when rest ends. Coming back to the app
 * cancels it; the in-app timer (sound + flash, lib/restTimer.ts) keeps working
 * on its own whether or not push is available.
 *
 * This module has two pure parts and no browser or React imports:
 * - the server handler (handleRestTimer), used by app/api/rest-timer/route.ts;
 * - the client controller (createRestTimerPushController), wrapped by the
 *   React hook in lib/restTimerPushClient.ts.
 *
 * Server order: config (503 {unavailable:true} without Supabase, the
 * service-role key or VAPID) -> sign-in (401, same resolver as the AI routes,
 * lib/ai/guard.ts) -> per-user rate limit (429) -> body with a byte cap
 * (400/413) -> strict validation, unknown keys rejected (400) -> the
 * subscription must be stored for this user (404 {error:"not_subscribed"}) ->
 * schedule. The push only ever goes to a subscription the user saved through
 * /api/push/subscribe, never to an endpoint taken from the request as-is.
 *
 * The wait runs inside the request's own function (next/server `after()`), so
 * the delay is capped below the route's maxDuration. Pending pushes live in
 * memory: a cancel that lands on another server instance cannot stop one, so
 * the worst case is one extra "rest over" ping. The payload is fixed text; no
 * user input reaches it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiRateLimited, aiUnauthorized, createRateLimiter, supabaseConfiguredFrom, type AiUserResolver, type RateLimiter } from "./ai/guard";
import { invalidRequest, readJsonBody } from "./ai/request";
import { adminConfiguredFrom, isAllowedPushEndpoint, toPushSub, vapidConfiguredFrom, type PushEnv, type PushSub } from "./push/endpoint";
import type { PushSender } from "./push/send";

export const REST_TIMER_URL = "/api/rest-timer";
export const MAX_REST_TIMER_BYTES = 2048;
/** Shortest delay worth a push; anything sooner the user sees in the app. */
export const MIN_REST_DELAY_SEC = 1;
/** Longest delay: the wait must finish inside the route's maxDuration (300s). */
export const MAX_REST_DELAY_SEC = 290;

/** Fixed notification payload, read by public/sw.js. */
export const REST_PUSH_PAYLOAD = {
  title: "Rest over",
  body: "Time for your next set.",
  tag: "lift-rest",
  url: "/workout",
  kind: "rest",
} as const;

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

// ---------- Client controller ----------

/** localStorage key for the per-phone opt-in. */
export const REST_PUSH_LS = "lift:rest-push";

export type RestTimerSnapshot = { endsAt: number } | null;

export type RestPushControllerDeps = {
  /** Opt-in toggle is on. */
  enabled: () => boolean;
  /** Browser and build can do Web Push (lib/push/client pushAvailable). */
  available: () => boolean;
  /** Page is in the background or the phone is locked. */
  hidden: () => boolean;
  timer: () => RestTimerSnapshot;
  /** This phone's push subscription endpoint, or null when not subscribed. */
  endpoint: () => Promise<string | null>;
  fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
  now: () => number;
};

export type RestPushStatus = "idle" | "scheduled" | "fallback";

export interface RestPushController {
  /** Re-check timer, visibility and opt-in; schedules or cancels as needed. */
  sync(): Promise<void>;
  status(): RestPushStatus;
}

/** Whole seconds until `endsAt`, or null when out of the pushable range. */
export function restDelaySec(endsAt: number, now: number): number | null {
  const sec = Math.ceil((endsAt - now) / 1000);
  return sec >= MIN_REST_DELAY_SEC && sec <= MAX_REST_DELAY_SEC ? sec : null;
}

/**
 * Schedules a server push while the page is hidden and a timer runs; cancels
 * it when the page is visible again or the timer stops. Any failure leaves
 * status "fallback" and the in-app timer as the only alert.
 */
export function createRestTimerPushController(deps: RestPushControllerDeps): RestPushController {
  let scheduled: { endsAt: number; endpoint: string } | null = null;
  let status: RestPushStatus = "idle";
  let chain: Promise<void> = Promise.resolve();

  const send = (method: "POST" | "DELETE", body: unknown) =>
    deps.fetch(REST_TIMER_URL, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });

  async function step() {
    const t = deps.timer();
    const delay = t ? restDelaySec(t.endsAt, deps.now()) : null;
    const want = t && delay !== null && deps.enabled() && deps.available() && deps.hidden() ? t.endsAt : null;
    if (want !== null && scheduled?.endsAt === want) return;

    if (want === null) {
      if (!scheduled) return;
      const { endpoint } = scheduled;
      scheduled = null;
      status = "idle";
      await send("DELETE", { endpoint }).catch(() => undefined);
      return;
    }

    const prev = scheduled;
    const fail = async () => {
      scheduled = null;
      status = "fallback";
      // A push for the old end time would now ping at the wrong moment.
      if (prev) await send("DELETE", { endpoint: prev.endpoint }).catch(() => undefined);
    };
    try {
      const endpoint = await deps.endpoint();
      if (!endpoint) return await fail();
      // The server replaces a pending push for the same phone.
      const res = await send("POST", { endpoint, delaySec: delay });
      if (!res.ok) return await fail();
      scheduled = { endsAt: want, endpoint };
      status = "scheduled";
    } catch {
      await fail();
    }
  }

  return {
    sync() {
      chain = chain.then(step, step);
      return chain;
    },
    status: () => status,
  };
}
