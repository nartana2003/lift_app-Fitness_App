import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// web-push is mocked: nothing is ever sent. Supabase is a hand-written fake.
const wp = vi.hoisted(() => ({ calls: [] as unknown[][], fail: null as null | { statusCode: number } }));
vi.mock("web-push", () => ({
  default: {
    sendNotification: async (...args: unknown[]) => {
      wp.calls.push(args);
      if (wp.fail) throw wp.fail;
      return { statusCode: 201 };
    },
  },
}));

import { createRateLimiter } from "../ai/guard";
import { webPushSender, type PushSender } from "../push/send";
import type { PushSub } from "../push/endpoint";
import {
  createRestScheduler,
  createRestTimerLimiter,
  handleRestTimer,
  parseRestCancelBody,
  parseRestTimerBody,
  supabaseRestSubscriptionStore,
  type RestSubscriptionStore,
  type RestTimerDeps,
} from "../restTimerPushServer";
import {
  createRestTimerPushController,
  MAX_REST_DELAY_SEC,
  MAX_REST_TIMER_BYTES,
  REST_PUSH_PAYLOAD,
  REST_TIMER_URL,
  restDelaySec,
  type RestPushControllerDeps,
  type RestTimerSnapshot,
} from "../restTimerPush";

const P256 = "B" + "A".repeat(86);
const AUTH = "a".repeat(22);
const EP = "https://fcm.googleapis.com/fcm/send/abc";
const SUB: PushSub = { endpoint: EP, keys: { p256dh: P256, auth: AUTH } };
const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "pub",
  VAPID_PRIVATE_KEY: "priv",
  VAPID_SUBJECT: "mailto:a@b.c",
};

afterEach(() => {
  wp.calls.length = 0;
  wp.fail = null;
  vi.useRealTimers();
});

function setup(o: Partial<RestTimerDeps> = {}, subs: Record<string, PushSub> = { [`u1|${EP}`]: SUB }) {
  const sent: [PushSub, string][] = [];
  const removed: [string, string][] = [];
  const kept: Promise<void>[] = [];
  const store: RestSubscriptionStore = {
    find: async (u, e) => subs[`${u}|${e}`] ?? null,
    remove: async (u, e) => void removed.push([u, e]),
  };
  const sender: PushSender = async (s, p) => {
    sent.push([s, p]);
    return { ok: true };
  };
  const deps: RestTimerDeps = {
    env: ENV,
    resolveUser: async () => ({ id: "u1" }),
    store: () => store,
    send: () => sender,
    limiter: createRateLimiter([{ windowMs: 60_000, max: 100 }]),
    scheduler: createRestScheduler(),
    keepAlive: (p) => void kept.push(p),
    ...o,
  };
  return { deps, sent, removed, kept };
}

const req = (method: "POST" | "DELETE", body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost" + REST_TIMER_URL, {
    method,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });

describe("parse bodies", () => {
  it("accepts endpoint + whole delaySec in range", () => {
    expect(parseRestTimerBody({ endpoint: EP, delaySec: 90 })).toEqual({ endpoint: EP, delaySec: 90 });
    expect(parseRestTimerBody({ endpoint: EP, delaySec: 1 })).not.toBeNull();
    expect(parseRestTimerBody({ endpoint: EP, delaySec: MAX_REST_DELAY_SEC })).not.toBeNull();
  });

  it("rejects bad delays, extra keys and foreign endpoints", () => {
    for (const delaySec of [0, -5, 1.5, MAX_REST_DELAY_SEC + 1, "90", null, NaN, Infinity]) {
      expect(parseRestTimerBody({ endpoint: EP, delaySec })).toBeNull();
    }
    expect(parseRestTimerBody({ endpoint: EP, delaySec: 90, title: "hi" })).toBeNull();
    expect(parseRestTimerBody({ endpoint: EP, delaySec: 90, user_id: "u2" })).toBeNull();
    expect(parseRestTimerBody({ endpoint: "http://169.254.169.254/", delaySec: 90 })).toBeNull();
    expect(parseRestTimerBody({ endpoint: "https://evil.example/x", delaySec: 90 })).toBeNull();
    expect(parseRestTimerBody([EP, 90])).toBeNull();
    expect(parseRestTimerBody(null)).toBeNull();
    expect(parseRestCancelBody({ endpoint: EP })).toBe(EP);
    expect(parseRestCancelBody({ endpoint: EP, delaySec: 1 })).toBeNull();
    expect(parseRestCancelBody({ endpoint: "https://evil.example" })).toBeNull();
  });
});

describe("handleRestTimer", () => {
  it("503 when Supabase, the service-role key or VAPID is missing", async () => {
    for (const drop of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "VAPID_PRIVATE_KEY", "NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_SUBJECT"]) {
      const env: Record<string, string | undefined> = { ...ENV, [drop]: undefined };
      const { deps } = setup({ env });
      const res = await handleRestTimer(req("POST", { endpoint: EP, delaySec: 90 }), deps);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ unavailable: true });
    }
  });

  it("401 without a user or when the lookup throws", async () => {
    for (const resolveUser of [async () => null, async () => ({ id: " " }), async () => Promise.reject(new Error("x"))]) {
      const { deps } = setup({ resolveUser });
      const res = await handleRestTimer(req("POST", { endpoint: EP, delaySec: 90 }), deps);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("429 over the per-user limit", async () => {
    const { deps } = setup({ limiter: createRateLimiter([{ windowMs: 60_000, max: 1 }]) });
    expect((await handleRestTimer(req("DELETE", { endpoint: EP }), deps)).status).toBe(200);
    const res = await handleRestTimer(req("DELETE", { endpoint: EP }), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("caps the body and rejects bad JSON and unknown keys", async () => {
    const { deps } = setup();
    const big = JSON.stringify({ endpoint: EP, delaySec: 90, pad: "x".repeat(MAX_REST_TIMER_BYTES) });
    expect((await handleRestTimer(req("POST", big), deps)).status).toBe(413);
    expect((await handleRestTimer(req("POST", "{nope"), deps)).status).toBe(400);
    const extra = await handleRestTimer(req("POST", { endpoint: EP, delaySec: 90, body: "</x>" }), deps);
    expect(extra.status).toBe(400);
    expect(await extra.json()).toEqual({ error: "invalid_request" });
  });

  it("404 when the endpoint is not this user's stored subscription", async () => {
    const { deps, kept } = setup({ resolveUser: async () => ({ id: "u2" }) });
    const res = await handleRestTimer(req("POST", { endpoint: EP, delaySec: 90 }), deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_subscribed" });
    expect(kept).toHaveLength(0);
  });

  it("500 when the lookup fails", async () => {
    const { deps } = setup({
      store: () => ({ find: async () => Promise.reject(new Error("db")), remove: async () => undefined }),
    });
    expect((await handleRestTimer(req("POST", { endpoint: EP, delaySec: 90 }), deps)).status).toBe(500);
  });

  it("schedules the fixed payload to the stored subscription after delaySec", async () => {
    vi.useFakeTimers();
    const { deps, sent, kept } = setup();
    const res = await handleRestTimer(req("POST", { endpoint: EP, delaySec: 90 }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delaySec: 90 });
    expect(kept).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(89_000);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await kept[0];
    expect(sent).toEqual([[SUB, JSON.stringify(REST_PUSH_PAYLOAD)]]);
    expect(deps.scheduler.pending()).toBe(0);
  });

  it("a new POST replaces the pending push; DELETE cancels it", async () => {
    vi.useFakeTimers();
    const { deps, sent, kept } = setup();
    await handleRestTimer(req("POST", { endpoint: EP, delaySec: 90 }), deps);
    await handleRestTimer(req("POST", { endpoint: EP, delaySec: 120 }), deps);
    await kept[0]; // the replaced one resolves without sending
    expect(deps.scheduler.pending()).toBe(1);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(sent).toHaveLength(0);
    const del = await handleRestTimer(req("DELETE", { endpoint: EP }), deps);
    expect(await del.json()).toEqual({ ok: true, cancelled: true });
    await kept[1];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(0);
    const again = await handleRestTimer(req("DELETE", { endpoint: EP }), deps);
    expect(await again.json()).toEqual({ ok: true, cancelled: false });
  });

  it("a cancel by another user does not touch this user's push", async () => {
    vi.useFakeTimers();
    let who = "u1";
    const { deps, sent } = setup({ resolveUser: async () => ({ id: who }) });
    await handleRestTimer(req("POST", { endpoint: EP, delaySec: 5 }), deps);
    who = "u2";
    const del = await handleRestTimer(req("DELETE", { endpoint: EP }), deps);
    expect(await del.json()).toEqual({ ok: true, cancelled: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(1);
  });

  it("drops a subscription the push service reports gone", async () => {
    vi.useFakeTimers();
    const { deps, removed, kept } = setup({ send: () => async () => ({ ok: false, gone: true }) });
    await handleRestTimer(req("POST", { endpoint: EP, delaySec: 1 }), deps);
    await vi.advanceTimersByTimeAsync(1_000);
    await kept[0];
    expect(removed).toEqual([["u1", EP]]);
  });

  it("sends through mocked web-push with the VAPID env", async () => {
    vi.useFakeTimers();
    const { deps, kept } = setup({ send: () => webPushSender(ENV) });
    await handleRestTimer(req("POST", { endpoint: EP, delaySec: 2 }), deps);
    await vi.advanceTimersByTimeAsync(2_000);
    await kept[0];
    expect(wp.calls).toHaveLength(1);
    expect(wp.calls[0][1]).toBe(JSON.stringify(REST_PUSH_PAYLOAD));
  });

  it("a failing send never throws out of the scheduler", async () => {
    vi.useFakeTimers();
    const { deps, kept } = setup({ send: () => async () => Promise.reject(new Error("boom")) });
    await handleRestTimer(req("POST", { endpoint: EP, delaySec: 1 }), deps);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(kept[0]).resolves.toBeUndefined();
  });

  it("default limiter allows a normal session", () => {
    const l = createRestTimerLimiter();
    for (let i = 0; i < 30; i++) expect(l.check("u").ok).toBe(true);
    expect(l.check("u").ok).toBe(false);
  });
});

describe("createRestScheduler", () => {
  it("evicts the oldest job past the cap", async () => {
    vi.useFakeTimers();
    const s = createRestScheduler(undefined, 2);
    const ran: string[] = [];
    const a = s.schedule("a", 1000, async () => void ran.push("a"));
    s.schedule("b", 1000, async () => void ran.push("b"));
    s.schedule("c", 1000, async () => void ran.push("c"));
    await a;
    expect(s.pending()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ran).toEqual(["b", "c"]);
  });
});

describe("supabaseRestSubscriptionStore", () => {
  function fakeAdmin(row: unknown, error: unknown = null) {
    const calls: [string, ...unknown[]][] = [];
    const q = {
      select: (...a: unknown[]) => (calls.push(["select", ...a]), q),
      eq: (...a: unknown[]) => (calls.push(["eq", ...a]), q),
      delete: () => (calls.push(["delete"]), q),
      maybeSingle: async () => ({ data: row, error }),
      then: (r: (v: unknown) => unknown) => r({ error: null }),
    };
    const admin = { from: (t: string) => (calls.push(["from", t]), q) } as unknown as SupabaseClient;
    return { admin, calls };
  }

  it("finds only this user's row and cleans it", async () => {
    const { admin, calls } = fakeAdmin({ endpoint: EP, keys: SUB.keys });
    expect(await supabaseRestSubscriptionStore(admin).find("u1", EP)).toEqual(SUB);
    expect(calls).toContainEqual(["eq", "user_id", "u1"]);
    expect(calls).toContainEqual(["eq", "endpoint", EP]);
  });

  it("null for a missing or malformed row, throws on error", async () => {
    expect(await supabaseRestSubscriptionStore(fakeAdmin(null).admin).find("u1", EP)).toBeNull();
    expect(await supabaseRestSubscriptionStore(fakeAdmin({ endpoint: EP, keys: { p256dh: "x" } }).admin).find("u1", EP)).toBeNull();
    await expect(supabaseRestSubscriptionStore(fakeAdmin(null, { message: "x" }).admin).find("u1", EP)).rejects.toThrow();
  });

  it("remove is scoped to the user", async () => {
    const { admin, calls } = fakeAdmin(null);
    await supabaseRestSubscriptionStore(admin).remove("u1", EP);
    expect(calls).toContainEqual(["delete"]);
    expect(calls).toContainEqual(["eq", "user_id", "u1"]);
  });
});

describe("restDelaySec", () => {
  it("rounds up and keeps the range", () => {
    expect(restDelaySec(10_500, 0)).toBe(11);
    expect(restDelaySec(0, 0)).toBeNull();
    expect(restDelaySec(-1000, 0)).toBeNull();
    expect(restDelaySec(MAX_REST_DELAY_SEC * 1000, 0)).toBe(MAX_REST_DELAY_SEC);
    expect(restDelaySec(MAX_REST_DELAY_SEC * 1000 + 1, 0)).toBeNull();
  });
});

describe("createRestTimerPushController", () => {
  function ctl(o: Partial<RestPushControllerDeps> = {}) {
    const st = { enabled: true, available: true, hidden: false, timer: { endsAt: 90_000 } as RestTimerSnapshot, endpoint: EP as string | null, status: 200 };
    const calls: { method: string; body: unknown }[] = [];
    const c = createRestTimerPushController({
      enabled: () => st.enabled,
      available: () => st.available,
      hidden: () => st.hidden,
      timer: () => st.timer,
      endpoint: async () => st.endpoint,
      fetch: async (url, init) => {
        expect(url).toBe(REST_TIMER_URL);
        calls.push({ method: String(init.method), body: JSON.parse(String(init.body)) });
        return { ok: st.status < 300, status: st.status };
      },
      now: () => 0,
      ...o,
    });
    return { c, st, calls };
  }

  it("does nothing while the app is visible", async () => {
    const { c, calls } = ctl();
    await c.sync();
    expect(calls).toEqual([]);
    expect(c.status()).toBe("idle");
  });

  it("schedules once when hidden and cancels when visible again", async () => {
    const { c, st, calls } = ctl();
    st.hidden = true;
    await c.sync();
    await c.sync();
    expect(calls).toEqual([{ method: "POST", body: { endpoint: EP, delaySec: 90 } }]);
    expect(c.status()).toBe("scheduled");
    st.hidden = false;
    await c.sync();
    expect(calls[1]).toEqual({ method: "DELETE", body: { endpoint: EP } });
    expect(c.status()).toBe("idle");
  });

  it("reschedules when the timer changes and cancels when it stops", async () => {
    const { c, st, calls } = ctl();
    st.hidden = true;
    await c.sync();
    st.timer = { endsAt: 105_000 };
    await c.sync();
    expect(calls[1]).toEqual({ method: "POST", body: { endpoint: EP, delaySec: 105 } });
    st.timer = null;
    await c.sync();
    expect(calls[2].method).toBe("DELETE");
  });

  it("sends nothing when opted out, unavailable, out of range or not subscribed", async () => {
    for (const patch of [{ enabled: false }, { available: false }, { timer: { endsAt: (MAX_REST_DELAY_SEC + 5) * 1000 } }, { timer: { endsAt: 0 } }]) {
      const { c, st, calls } = ctl();
      Object.assign(st, { hidden: true }, patch);
      await c.sync();
      expect(calls).toEqual([]);
    }
    const { c, st, calls } = ctl();
    st.hidden = true;
    st.endpoint = null;
    await c.sync();
    expect(calls).toEqual([]);
    expect(c.status()).toBe("fallback");
  });

  it("falls back when the server says no (503, 401, 404) or the network fails", async () => {
    for (const status of [503, 401, 404]) {
      const { c, st } = ctl();
      st.hidden = true;
      st.status = status;
      await c.sync();
      expect(c.status()).toBe("fallback");
    }
    const { c, st } = ctl({ fetch: async () => Promise.reject(new Error("offline")) });
    st.hidden = true;
    await c.sync();
    expect(c.status()).toBe("fallback");
  });

  it("cancels the old push when rescheduling fails", async () => {
    const { c, st, calls } = ctl();
    st.hidden = true;
    await c.sync();
    st.timer = { endsAt: 60_000 };
    st.status = 500;
    await c.sync();
    expect(calls.map((x) => x.method)).toEqual(["POST", "POST", "DELETE"]);
    expect(c.status()).toBe("fallback");
  });

  it("serialises overlapping syncs", async () => {
    const { c, st, calls } = ctl();
    st.hidden = true;
    await Promise.all([c.sync(), c.sync(), c.sync()]);
    expect(calls).toHaveLength(1);
  });
});

describe("module split (client bundles must not pull in next/headers)", () => {
  it("the client-safe modules import nothing server-side", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const f of ["restTimerPush.ts", "restTimerPushClient.ts"]) {
      const src = readFileSync(join(__dirname, "..", f), "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const bad of ["ai/guard", "ai/request", "supabase/server", "restTimerPushServer", "next/headers", "push/send", "push/subscribe"]) {
        expect(imports.filter((i) => i.includes(bad)), `${f} imports ${bad}`).toEqual([]);
      }
    }
  });
});
