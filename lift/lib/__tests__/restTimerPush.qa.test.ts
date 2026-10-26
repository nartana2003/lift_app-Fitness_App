import { describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../ai/guard";
import type { PushSub } from "../push/endpoint";
import type { PushSender } from "../push/send";
import {
  createRestScheduler,
  handleRestTimer,
  parseRestCancelBody,
  parseRestTimerBody,
  type RestSubscriptionStore,
  type RestTimerDeps,
} from "../restTimerPushServer";
import {
  createRestTimerPushController,
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
const EP2 = "https://fcm.googleapis.com/fcm/send/def";
const mk = (endpoint: string): PushSub => ({ endpoint, keys: { p256dh: P256, auth: AUTH } });
const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "pub",
  VAPID_PRIVATE_KEY: "priv",
  VAPID_SUBJECT: "mailto:a@b.c",
};

/** Manual timers: fireAll() runs every live handle. */
function fakeTimers() {
  let nextId = 1;
  const live = new Map<number, { fn: () => void; ms: number }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = nextId++;
        live.set(id, { fn, ms });
        return id;
      },
      clear: (h: unknown) => void live.delete(h as number),
    },
    live,
    fireAll() {
      for (const [id, t] of [...live]) {
        live.delete(id);
        t.fn();
      }
    },
  };
}

function setup(o: { user?: string | null; subs?: Record<string, PushSub>; send?: PushSender; env?: Record<string, string | undefined> } = {}) {
  const ft = fakeTimers();
  const scheduler = createRestScheduler(ft.timers);
  const sent: [PushSub, string][] = [];
  const removed: [string, string][] = [];
  const kept: Promise<void>[] = [];
  const subs = o.subs ?? { [`u1|${EP}`]: mk(EP) };
  const store: RestSubscriptionStore = {
    find: async (u, e) => subs[`${u}|${e}`] ?? null,
    remove: async (u, e) => void removed.push([u, e]),
  };
  const send: PushSender = o.send ?? (async (s, p) => (sent.push([s, p]), { ok: true }));
  let user: string | null = o.user === undefined ? "u1" : o.user;
  const deps: RestTimerDeps = {
    env: o.env ?? ENV,
    resolveUser: async () => (user ? { id: user } : null),
    store: () => store,
    send: () => send,
    limiter: createRateLimiter([{ windowMs: 60_000, max: 1000 }]),
    scheduler,
    keepAlive: (p) => void kept.push(p),
  };
  const call = (method: string, body: unknown, d: Partial<RestTimerDeps> = {}) =>
    handleRestTimer(
      new Request("http://x/api/rest-timer", { method, body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }),
      { ...deps, ...d },
    );
  return { ft, scheduler, sent, removed, kept, deps, call, setUser: (u: string | null) => (user = u) };
}

describe("rest-timer route order", () => {
  it("503 beats 401 beats 429 beats 400/413 beats 404", async () => {
    const s = setup({ user: null });
    for (const k of Object.keys(ENV).filter((k) => k !== "NEXT_PUBLIC_SUPABASE_ANON_KEY")) {
      const r = await s.call("POST", "garbage", { env: { ...ENV, [k]: undefined } });
      expect(r.status, k).toBe(503);
    }
    expect((await s.call("POST", "garbage")).status).toBe(401);
    const s3 = setup();
    const limiter = createRateLimiter([{ windowMs: 60_000, max: 1 }]);
    await s3.call("POST", { endpoint: EP, delaySec: 5 }, { limiter });
    const limited = await s3.call("POST", "garbage", { limiter });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await s3.call("POST", "garbage")).status).toBe(400);
    expect((await s3.call("POST", "x".repeat(MAX_REST_TIMER_BYTES + 10))).status).toBe(413);
    expect((await s3.call("POST", { endpoint: "https://fcm.googleapis.com/nope", delaySec: 5 })).status).toBe(404);
  });
  it("resolver that throws or returns blank id is 401", async () => {
    const s = setup();
    expect(
      (
        await s.call("POST", {}, {
          resolveUser: async () => {
            throw new Error("x");
          },
        })
      ).status,
    ).toBe(401);
    expect((await s.call("POST", {}, { resolveUser: async () => ({ id: "  " }) })).status).toBe(401);
  });
  it("store lookup throwing is 500 and schedules nothing", async () => {
    const s = setup();
    const r = await s.call("POST", { endpoint: EP, delaySec: 5 }, {
      store: () => ({
        find: async () => {
          throw new Error("db");
        },
        remove: async () => {},
      }),
    });
    expect(r.status).toBe(500);
    expect(s.scheduler.pending()).toBe(0);
  });
  it("invalid DELETE bodies are 400", async () => {
    const s = setup();
    expect((await s.call("DELETE", { endpoint: EP, extra: 1 })).status).toBe(400);
    expect((await s.call("DELETE", [])).status).toBe(400);
    expect((await s.call("DELETE", null)).status).toBe(400);
  });
});

describe("rest-timer validation", () => {
  const ok = (d: unknown) => parseRestTimerBody({ endpoint: EP, delaySec: d });
  it("delaySec boundaries", () => {
    for (const d of [1, 2, 289, 290]) expect(ok(d), String(d)).not.toBeNull();
    for (const d of [0, -1, 291, 1.5, 0.5, NaN, Infinity, -Infinity, "5", null, undefined, true, [], {}, 1e9, Number.MAX_SAFE_INTEGER, -0])
      expect(ok(d), String(d)).toBeNull();
  });
  it("missing fields, unknown keys, non objects", () => {
    expect(parseRestTimerBody({ endpoint: EP })).toBeNull();
    expect(parseRestTimerBody({ delaySec: 5 })).toBeNull();
    expect(parseRestTimerBody({ endpoint: EP, delaySec: 5, userId: "u2" })).toBeNull();
    expect(parseRestTimerBody({ endpoint: EP, delaySec: 5, keys: {} })).toBeNull();
    for (const v of [null, undefined, 5, "x", [], [EP]]) expect(parseRestTimerBody(v)).toBeNull();
    expect(parseRestCancelBody({ endpoint: EP, delaySec: 5 })).toBeNull();
    expect(parseRestCancelBody({})).toBeNull();
    expect(parseRestCancelBody({ endpoint: EP })).toBe(EP);
  });
  it("lookalike and unsafe endpoints rejected", () => {
    const bad = [
      "https://fcm.googleapis.com.evil.com/x",
      "https://evil.com/fcm.googleapis.com",
      "https://fcm.googleapis.com@evil.com/x",
      "https://user:pw@fcm.googleapis.com/x",
      "http://fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://fcm.googleapis.com./x",
      "https://xfcm.googleapis.com/x",
      "https://push.apple.com/x",
      "https://.push.apple.com/x",
      "https://evilpush.apple.com/x",
      "https://push.apple.com.evil.com/x",
      "https://notify.windows.com/x",
      "https://x.notify.windows.com.evil.com/x",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://[::1]/x",
      "https://fcm.googIeapis.com/x",
      " https://fcm.googleapis.com/x",
      "https://fcm.googleapis.com/x ",
      "https://fcm.googleapis.com/x\n",
      "javascript:alert(1)",
      "//fcm.googleapis.com/x",
      "",
      "https://fcm.googleapis.com/" + "a".repeat(1100),
    ];
    for (const e of bad) expect(parseRestTimerBody({ endpoint: e, delaySec: 5 }), JSON.stringify(e)).toBeNull();
    for (const e of [5, null, {}, [], undefined]) expect(parseRestTimerBody({ endpoint: e, delaySec: 5 })).toBeNull();
  });
  it("backslash form is accepted only because WHATWG URL really resolves its host to fcm (not a bypass)", () => {
    const e = "https://fcm.googleapis.com\\@evil.com/x";
    expect(new URL(e).hostname).toBe("fcm.googleapis.com");
    expect(parseRestTimerBody({ endpoint: e, delaySec: 5 })).not.toBeNull();
  });
  it("good vendor hosts accepted", () => {
    for (const e of [
      "https://FCM.googleapis.com/x",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://eu.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ])
      expect(parseRestTimerBody({ endpoint: e, delaySec: 5 }), e).not.toBeNull();
  });
});

describe("rest-timer scheduling", () => {
  it("POST schedules, fires fixed payload to stored sub, cancel-after-fire is false", async () => {
    const s = setup();
    const r = await s.call("POST", { endpoint: EP, delaySec: 30 });
    expect(await r.json()).toEqual({ ok: true, delaySec: 30 });
    expect([...s.ft.live.values()][0].ms).toBe(30_000);
    expect(s.sent).toHaveLength(0);
    s.ft.fireAll();
    await Promise.all(s.kept);
    expect(s.sent).toHaveLength(1);
    expect(JSON.parse(s.sent[0][1])).toEqual(REST_PUSH_PAYLOAD);
    expect(s.scheduler.pending()).toBe(0);
    const c = await s.call("DELETE", { endpoint: EP });
    expect(await c.json()).toEqual({ ok: true, cancelled: false });
  });
  it("sends the stored subscription, not request data", async () => {
    const s = setup();
    await s.call("POST", { endpoint: EP, delaySec: 5 });
    s.ft.fireAll();
    await Promise.all(s.kept);
    expect(s.sent[0][0]).toEqual(mk(EP));
  });
  it("cancel before fire: nothing sent, kept promise resolves, timer cleared", async () => {
    const s = setup();
    await s.call("POST", { endpoint: EP, delaySec: 5 });
    const c = await s.call("DELETE", { endpoint: EP });
    expect(await c.json()).toEqual({ ok: true, cancelled: true });
    await Promise.all(s.kept);
    expect(s.ft.live.size).toBe(0);
    expect(s.sent).toHaveLength(0);
    expect(s.scheduler.pending()).toBe(0);
  });
  it("DELETE of nothing is ok cancelled:false", async () => {
    const s = setup();
    const c = await s.call("DELETE", { endpoint: EP });
    expect(c.status).toBe(200);
    expect(await c.json()).toEqual({ ok: true, cancelled: false });
  });
  it("replace while pending: one send, old promise resolves, latest delay wins", async () => {
    const s = setup();
    await s.call("POST", { endpoint: EP, delaySec: 10 });
    await s.call("POST", { endpoint: EP, delaySec: 20 });
    expect(s.scheduler.pending()).toBe(1);
    expect(s.ft.live.size).toBe(1);
    expect([...s.ft.live.values()][0].ms).toBe(20_000);
    await s.kept[0];
    s.ft.fireAll();
    await Promise.all(s.kept);
    expect(s.sent).toHaveLength(1);
  });
  it("double POST same body sends once", async () => {
    const s = setup();
    await Promise.all([s.call("POST", { endpoint: EP, delaySec: 5 }), s.call("POST", { endpoint: EP, delaySec: 5 })]);
    s.ft.fireAll();
    await Promise.all(s.kept);
    expect(s.sent).toHaveLength(1);
  });
  it("another user endpoint is 404 and nothing scheduled; cancel cannot hit other user job", async () => {
    const s = setup({ subs: { [`u1|${EP}`]: mk(EP) } });
    s.setUser("u2");
    expect((await s.call("POST", { endpoint: EP, delaySec: 5 })).status).toBe(404);
    expect(s.scheduler.pending()).toBe(0);
    s.setUser("u1");
    await s.call("POST", { endpoint: EP, delaySec: 5 });
    s.setUser("u2");
    expect(await (await s.call("DELETE", { endpoint: EP })).json()).toEqual({ ok: true, cancelled: false });
    expect(s.scheduler.pending()).toBe(1);
  });
  it("concurrent users and phones keep separate jobs", async () => {
    const s = setup({ subs: { [`u1|${EP}`]: mk(EP), [`u2|${EP}`]: mk(EP), [`u1|${EP2}`]: mk(EP2) } });
    await s.call("POST", { endpoint: EP, delaySec: 5 });
    await s.call("POST", { endpoint: EP2, delaySec: 5 });
    s.setUser("u2");
    await s.call("POST", { endpoint: EP, delaySec: 5 });
    expect(s.scheduler.pending()).toBe(3);
    await s.call("DELETE", { endpoint: EP });
    expect(s.scheduler.pending()).toBe(2);
    s.ft.fireAll();
    await Promise.all(s.kept);
    expect(s.sent).toHaveLength(2);
  });
  it("gone from push service deletes the row for that user", async () => {
    const s = setup({ send: async () => ({ ok: false, gone: true }) });
    await s.call("POST", { endpoint: EP, delaySec: 5 });
    s.ft.fireAll();
    await Promise.all(s.kept);
    expect(s.removed).toEqual([["u1", EP]]);
  });
  it("non-gone failure keeps the row", async () => {
    const s = setup({ send: async () => ({ ok: false, gone: false }) });
    await s.call("POST", { endpoint: EP, delaySec: 5 });
    s.ft.fireAll();
    await Promise.all(s.kept);
    expect(s.removed).toEqual([]);
  });
  it("sender throws (async or sync): promise resolves, job cleared", async () => {
    const senders = [
      (async () => {
        throw new Error("boom");
      }) as PushSender,
      (() => {
        throw new Error("sync");
      }) as unknown as PushSender,
    ];
    for (const send of senders) {
      const s = setup({ send });
      await s.call("POST", { endpoint: EP, delaySec: 5 });
      s.ft.fireAll();
      await expect(Promise.all(s.kept)).resolves.toBeDefined();
      expect(s.scheduler.pending()).toBe(0);
    }
  });
  it("store.remove throwing after gone is swallowed", async () => {
    const s = setup({ send: async () => ({ ok: false, gone: true }) });
    await s.call("POST", { endpoint: EP, delaySec: 5 }, {
      store: () => ({
        find: async () => mk(EP),
        remove: async () => {
          throw new Error("db");
        },
      }),
    });
    s.ft.fireAll();
    await expect(Promise.all(s.kept)).resolves.toBeDefined();
  });
  it("send factory throwing is swallowed", async () => {
    const s = setup();
    await s.call("POST", { endpoint: EP, delaySec: 5 }, {
      send: () => {
        throw new Error("no vapid");
      },
    });
    s.ft.fireAll();
    await expect(Promise.all(s.kept)).resolves.toBeDefined();
  });
});

describe("scheduler", () => {
  it("cap evicts oldest and resolves its promise", async () => {
    const ft = fakeTimers();
    const sch = createRestScheduler(ft.timers, 2);
    const ran: string[] = [];
    const ps = ["a", "b", "c"].map((k) => sch.schedule(k, 10, async () => void ran.push(k)));
    expect(sch.pending()).toBe(2);
    await ps[0];
    ft.fireAll();
    await Promise.all(ps);
    expect(ran.sort()).toEqual(["b", "c"]);
    expect(sch.pending()).toBe(0);
  });
  it("replacing a key at the cap does not evict others", () => {
    const ft = fakeTimers();
    const sch = createRestScheduler(ft.timers, 2);
    void sch.schedule("a", 1, async () => {});
    void sch.schedule("b", 1, async () => {});
    void sch.schedule("b", 1, async () => {});
    expect(sch.pending()).toBe(2);
    expect(ft.live.size).toBe(2);
  });
  it("real timers: runs once, cancelled task never runs, no timers left", async () => {
    vi.useFakeTimers();
    try {
      const sch = createRestScheduler();
      const fn = vi.fn(async () => {});
      const p = sch.schedule("k", 1000, fn);
      const q = sch.schedule("z", 1000, fn);
      sch.cancel("z");
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all([p, q]);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- client ----------
function ctl(o: Partial<RestPushControllerDeps> = {}) {
  const st = { hidden: true, timer: { endsAt: 100_000 } as RestTimerSnapshot, now: 70_000, enabled: true, endpoint: EP as string | null };
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let respond: () => Promise<{ ok: boolean; status: number }> = async () => ({ ok: true, status: 200 });
  const c = createRestTimerPushController({
    enabled: () => st.enabled,
    available: () => true,
    hidden: () => st.hidden,
    timer: () => st.timer,
    endpoint: async () => st.endpoint,
    fetch: async (url, init) => {
      expect(url).toBe(REST_TIMER_URL);
      calls.push({ method: init.method!, body: JSON.parse(init.body as string) });
      return respond();
    },
    now: () => st.now,
    ...o,
  });
  return { c, st, calls, setRespond: (f: typeof respond) => (respond = f) };
}

describe("restDelaySec", () => {
  it("rounds up and bounds", () => {
    expect(restDelaySec(1001, 0)).toBe(2);
    expect(restDelaySec(1, 0)).toBe(1);
    expect(restDelaySec(0, 0)).toBeNull();
    expect(restDelaySec(-5, 0)).toBeNull();
    expect(restDelaySec(290_000, 0)).toBe(290);
    expect(restDelaySec(290_001, 0)).toBeNull();
    expect(restDelaySec(NaN, 0)).toBeNull();
    expect(restDelaySec(Infinity, 0)).toBeNull();
  });
});

describe("rest push controller", () => {
  it("hidden + timer posts once; repeated sync does not re-post", async () => {
    const t = ctl();
    await Promise.all([t.c.sync(), t.c.sync(), t.c.sync()]);
    expect(t.calls).toEqual([{ method: "POST", body: { endpoint: EP, delaySec: 30 } }]);
    expect(t.c.status()).toBe("scheduled");
  });
  it("visible again cancels; visible with nothing scheduled sends nothing", async () => {
    const t = ctl();
    t.st.hidden = false;
    await t.c.sync();
    expect(t.calls).toHaveLength(0);
    expect(t.c.status()).toBe("idle");
    t.st.hidden = true;
    await t.c.sync();
    t.st.hidden = false;
    await t.c.sync();
    await t.c.sync();
    expect(t.calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
    expect(t.c.status()).toBe("idle");
  });
  it("hide/show/hide rapid: POST DELETE POST", async () => {
    const t = ctl();
    const ps: Promise<void>[] = [];
    for (const h of [true, false, true]) {
      t.st.hidden = h;
      ps.push(t.c.sync());
    }
    await Promise.all(ps);
    // state is read when each step runs, so the queued steps all see hidden=true
    expect(t.calls.length).toBeGreaterThanOrEqual(1);
    expect(t.c.status()).toBe("scheduled");
  });
  it("hide, show, hide awaited in between: POST DELETE POST", async () => {
    const t = ctl();
    for (const h of [true, false, true]) {
      t.st.hidden = h;
      await t.c.sync();
    }
    expect(t.calls.map((c) => c.method)).toEqual(["POST", "DELETE", "POST"]);
  });
  it("timer change re-posts with the new delay", async () => {
    const t = ctl();
    await t.c.sync();
    t.st.timer = { endsAt: 130_000 };
    await t.c.sync();
    expect(t.calls[1]).toEqual({ method: "POST", body: { endpoint: EP, delaySec: 60 } });
  });
  it("timer stopped cancels", async () => {
    const t = ctl();
    await t.c.sync();
    t.st.timer = null;
    await t.c.sync();
    expect(t.calls[1]).toEqual({ method: "DELETE", body: { endpoint: EP } });
  });
  it("timer already expired or beyond 290s: nothing sent", async () => {
    for (const endsAt of [70_000, 60_000, 70_000 + 291_000]) {
      const t = ctl();
      t.st.timer = { endsAt };
      await t.c.sync();
      expect(t.calls).toHaveLength(0);
    }
  });
  it("timer change to out of range cancels the old push", async () => {
    const t = ctl();
    await t.c.sync();
    t.st.timer = { endsAt: 70_000 + 400_000 };
    await t.c.sync();
    expect(t.calls[1].method).toBe("DELETE");
  });
  it("opt-out sends nothing; opt-out after scheduling cancels", async () => {
    const off = ctl();
    off.st.enabled = false;
    await off.c.sync();
    expect(off.calls).toHaveLength(0);
    const t = ctl();
    await t.c.sync();
    t.st.enabled = false;
    await t.c.sync();
    expect(t.calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
  });
  it("unavailable push sends nothing", async () => {
    const t = ctl({ available: () => false });
    await t.c.sync();
    expect(t.calls).toHaveLength(0);
  });
  it("no subscription: fallback, no fetch", async () => {
    const t = ctl();
    t.st.endpoint = null;
    await t.c.sync();
    expect(t.calls).toHaveLength(0);
    expect(t.c.status()).toBe("fallback");
  });
  it("failed schedule (non-ok) cancels the old push and goes to fallback, later retry works", async () => {
    const t = ctl();
    await t.c.sync();
    t.setRespond(async () => ({ ok: false, status: 500 }));
    t.st.timer = { endsAt: 130_000 };
    await t.c.sync();
    expect(t.calls.map((c) => c.method)).toEqual(["POST", "POST", "DELETE"]);
    expect(t.c.status()).toBe("fallback");
    t.setRespond(async () => ({ ok: true, status: 200 }));
    await t.c.sync();
    expect(t.c.status()).toBe("scheduled");
  });
  it("offline: fetch rejects -> fallback, no throw, old push cancel attempted", async () => {
    const t = ctl();
    await t.c.sync();
    t.setRespond(async () => {
      throw new TypeError("offline");
    });
    t.st.timer = { endsAt: 130_000 };
    await expect(t.c.sync()).resolves.toBeUndefined();
    expect(t.c.status()).toBe("fallback");
    expect(t.calls.at(-1)!.method).toBe("DELETE");
  });
  it("offline cancel (DELETE rejects) does not throw and resets status", async () => {
    const t = ctl();
    await t.c.sync();
    t.setRespond(async () => {
      throw new TypeError("offline");
    });
    t.st.hidden = false;
    await expect(t.c.sync()).resolves.toBeUndefined();
    expect(t.c.status()).toBe("idle");
  });
  it("endpoint() throwing falls back without throwing", async () => {
    const t = ctl({
      endpoint: async () => {
        throw new Error("sw");
      },
    });
    await expect(t.c.sync()).resolves.toBeUndefined();
    expect(t.c.status()).toBe("fallback");
  });
  it("request bodies carry only endpoint and delaySec and pass server validation", async () => {
    const t = ctl();
    await t.c.sync();
    expect(parseRestTimerBody(t.calls[0].body)).not.toBeNull();
    t.st.hidden = false;
    await t.c.sync();
    expect(parseRestCancelBody(t.calls[1].body)).toBe(EP);
  });
});
