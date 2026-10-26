/**
 * Rest-timer push (PLAN.md line 97), client-safe half: shared constants and
 * the pure client controller. No server imports, so components may import it.
 * The server handler, scheduler and Supabase store are in
 * lib/restTimerPushServer.ts (imported only by app/api/rest-timer/route.ts).
 *
 * Flow: when the rest timer is running and Lift goes to the background or the phone locks, the app asks /api/rest-timer to
 * send this phone a short delayed push when rest ends. Coming back to the app
 * cancels it; the in-app timer (sound + flash, lib/restTimer.ts) keeps working
 * on its own whether or not push is available.
 *
 * Two halves, neither with browser or React imports:
 * - the server handler (handleRestTimer in lib/restTimerPushServer.ts), used by app/api/rest-timer/route.ts;
 * - the client controller here (createRestTimerPushController), wrapped by the
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
