import { readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAiClientFactory, type AiClient } from "../client";
import {
  AI_RATE_LIMITS,
  createRateLimiter,
  guardAiRequest,
  setAiRateLimiter,
  setAiUserResolver,
  supabaseConfiguredFrom,
  type AiUserResolver,
  type RateLimiter,
} from "../guard";
import { withAiClient } from "../respond";

const SUPA = { NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" };
const KEY = { ANTHROPIC_API_KEY: "test-key" };
const ENV = { ...SUPA, ...KEY };

afterEach(() => {
  setAiUserResolver(null);
  setAiRateLimiter(null);
  setAiClientFactory(null);
  vi.unstubAllEnvs();
});

const asResolver = (fn: unknown) => fn as AiUserResolver;

describe("guard bypass attempts: resolver shapes", () => {
  it.each([
    ["whitespace id", { id: "   " }],
    ["undefined", undefined],
    ["number id", { id: 5 }],
    ["null id", { id: null }],
    ["string instead of object", "user-1"],
    ["array", []],
    ["empty object", {}],
    ["false", false],
    ["0", 0],
  ])("%s -> 401", async (name, value) => {
    setAiUserResolver(asResolver(async () => value));
    const res = await guardAiRequest(ENV);
    expect(res?.status, String(name)).toBe(401);
  });

  it("rejects a rejected promise and a sync throw", async () => {
    setAiUserResolver(asResolver(() => Promise.reject(new Error("boom"))));
    expect((await guardAiRequest(ENV))?.status).toBe(401);
    setAiUserResolver(
      asResolver(() => {
        throw new Error("sync");
      }),
    );
    expect((await guardAiRequest(ENV))?.status).toBe(401);
  });

  it("401 body leaks no resolver error text", async () => {
    setAiUserResolver(asResolver(async () => Promise.reject(new Error("secret-token-xyz"))));
    const res = await guardAiRequest(ENV);
    expect(await res!.text()).toBe('{"error":"unauthorized"}');
  });

  it("a hanging resolver never lets the request through (no timeout exists)", async () => {
    setAiUserResolver(asResolver(() => new Promise(() => {})));
    const outcome = await Promise.race([
      guardAiRequest(ENV).then(() => "settled"),
      new Promise((r) => setTimeout(() => r("pending"), 50)),
    ]);
    expect(outcome).toBe("pending");
  });

  it("a user object with extra fields uses only the id string", async () => {
    const seen: string[] = [];
    setAiRateLimiter({ check: (k) => (seen.push(k), { ok: true }), reset() {} });
    setAiUserResolver(asResolver(async () => ({ id: "u1", role: "admin", id2: "x" })));
    expect(await guardAiRequest(ENV)).toBeNull();
    expect(seen).toEqual(["u1"]);
  });

  it("guard takes no request: resolver is called with no args and is the only identity source", async () => {
    const resolver = vi.fn(async () => null);
    setAiUserResolver(resolver);
    expect((await guardAiRequest(ENV))?.status).toBe(401);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]).toEqual([]);
  });
});

describe("supabaseConfiguredFrom edge cases", () => {
  it.each([
    [{ NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" }, false],
    [{ NEXT_PUBLIC_SUPABASE_URL: "https://x.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "" }, false],
    [{ NEXT_PUBLIC_SUPABASE_URL: "https://YOUR-PROJECT.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" }, false],
    [{}, false],
    [{ NEXT_PUBLIC_SUPABASE_URL: "https://x.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" }, true],
  ])("%j -> %s", (env, want) => {
    expect(supabaseConfiguredFrom(env)).toBe(want);
  });

  it("local-only mode skips resolver and limiter entirely", async () => {
    const r = vi.fn(async () => null);
    const check = vi.fn(() => ({ ok: false as const, retryAfterSec: 1 }));
    setAiUserResolver(r);
    setAiRateLimiter({ check, reset() {} });
    expect(await guardAiRequest({})).toBeNull();
    expect(r).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });
});

describe("rate limiter boundaries", () => {
  const L = [{ windowMs: 1000, max: 2 }];
  function clk(t = 10_000) {
    return { now: () => t, set: (v: number) => (t = v), add: (ms: number) => (t += ms) };
  }

  it("slot frees exactly at windowMs, not one ms before", () => {
    const c = clk();
    const rl = createRateLimiter(L, c.now);
    rl.check("a");
    rl.check("a");
    c.add(999);
    expect(rl.check("a").ok).toBe(false);
    c.add(1);
    expect(rl.check("a").ok).toBe(true);
  });

  it("Retry-After is an integer >= 1 and waiting that long always succeeds", () => {
    for (const off of [0, 1, 400, 899]) {
      const c = clk();
      const rl = createRateLimiter(L, c.now);
      rl.check("a");
      c.add(100);
      rl.check("a");
      c.set(10_100 + off);
      const r = rl.check("a");
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(Number.isInteger(r.retryAfterSec)).toBe(true);
      expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
      c.add(r.retryAfterSec * 1000);
      expect(rl.check("a").ok).toBe(true);
    }
  });

  it("Retry-After uses the longest blocking window across windows", () => {
    const c = clk(0);
    const rl = createRateLimiter(
      [
        { windowMs: 1000, max: 1 },
        { windowMs: 100_000, max: 2 },
      ],
      c.now,
    );
    rl.check("a");
    c.add(1500);
    rl.check("a");
    c.add(1500);
    expect(rl.check("a")).toEqual({ ok: false, retryAfterSec: 97 });
  });

  it("clock going backwards does not crash and does not grant unlimited calls", () => {
    const c = clk(50_000);
    const rl = createRateLimiter(L, c.now);
    rl.check("a");
    rl.check("a");
    c.set(1_000);
    const r = rl.check("a");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Number.isFinite(r.retryAfterSec)).toBe(true);
      expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
    }
  });

  it("clock going backwards: Retry-After stays bounded by the window", () => {
    const c = clk(50_000);
    const rl = createRateLimiter(L, c.now);
    rl.check("a");
    rl.check("a");
    c.set(1_000);
    const r = rl.check("a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSec).toBeLessThanOrEqual(1);
  });

  it("clock jumping far forward resets cleanly", () => {
    const c = clk();
    const rl = createRateLimiter(L, c.now);
    rl.check("a");
    rl.check("a");
    c.add(10 ** 12);
    expect(rl.check("a").ok).toBe(true);
  });

  it("odd keys isolate: empty, proto-like and huge keys", () => {
    const rl = createRateLimiter(L, () => 5);
    for (const k of ["", "__proto__", "constructor", "x".repeat(100_000)]) {
      expect(rl.check(k).ok).toBe(true);
      expect(rl.check(k).ok).toBe(true);
      expect(rl.check(k).ok).toBe(false);
    }
    expect(rl.check("toString").ok).toBe(true);
  });

  it("keys differing by case or whitespace are distinct users", () => {
    const rl = createRateLimiter([{ windowMs: 1000, max: 1 }], () => 5);
    expect(rl.check("U1").ok).toBe(true);
    expect(rl.check("u1").ok).toBe(true);
    expect(rl.check("u1 ").ok).toBe(true);
    expect(rl.check("U1").ok).toBe(false);
  });

  it("memory cap: map never exceeds maxKeys (observed via eviction of the oldest idle user)", () => {
    const rl = createRateLimiter([{ windowMs: 10_000, max: 1 }], () => 1, 50);
    rl.check("first");
    for (let i = 0; i < 49; i++) rl.check(`u${i}`);
    expect(rl.check("first").ok).toBe(false); // still tracked at exactly the cap
    // "first" was refreshed by the blocked check? it is re-set on block only via hits.set (order unchanged).
    for (let i = 0; i < 200; i++) rl.check(`n${i}`);
    expect(rl.check("n199").ok).toBe(false); // most recent still tracked
  });

  it("memory cap: a blocked user flooded out by other ids gets fresh quota only after maxKeys distinct ids", () => {
    const rl = createRateLimiter([{ windowMs: 10_000, max: 1 }], () => 1, 10);
    rl.check("victim");
    for (let i = 0; i < 9; i++) rl.check(`o${i}`);
    expect(rl.check("victim").ok).toBe(false);
    for (let i = 0; i < 100; i++) rl.check(`p${i}`);
    expect(rl.check("victim").ok).toBe(true); // documented limit of an LRU cap
  });

  it("maxKeys of 1 still works", () => {
    const rl = createRateLimiter([{ windowMs: 1000, max: 1 }], () => 1, 1);
    expect(rl.check("a").ok).toBe(true);
    expect(rl.check("a").ok).toBe(false);
    expect(rl.check("b").ok).toBe(true);
  });

  it("fuzz: never more than max allowed in any window, fixed seed", () => {
    let s = 12345;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    let t = 0;
    const lim = [
      { windowMs: 500, max: 3 },
      { windowMs: 5000, max: 10 },
    ];
    const rl = createRateLimiter(lim, () => t, 5);
    const allowed = new Map<string, number[]>();
    for (let i = 0; i < 5000; i++) {
      t += Math.floor(rnd() * 300);
      const k = `u${Math.floor(rnd() * 3)}`;
      if (rl.check(k).ok) {
        const arr = allowed.get(k) ?? [];
        arr.push(t);
        allowed.set(k, arr);
        for (const { windowMs, max } of lim) {
          expect(arr.filter((h) => t - h < windowMs).length).toBeLessThanOrEqual(max);
        }
      }
    }
  });

  it("default limits: 31st call within a minute blocked; daily cap 300", () => {
    let t = 0;
    const rl = createRateLimiter(AI_RATE_LIMITS, () => t);
    let ok = 0;
    for (let i = 0; i < 31; i++) if (rl.check("a").ok) ok++;
    expect(ok).toBe(30);
    const rl2 = createRateLimiter(AI_RATE_LIMITS, () => t);
    let n = 0;
    for (let i = 0; i < 400; i++) {
      t += 6_000;
      if (rl2.check("b").ok) n++;
    }
    expect(n).toBe(300);
  });

  it("reset() restores quota", () => {
    const rl = createRateLimiter([{ windowMs: 1000, max: 1 }], () => 1);
    rl.check("a");
    expect(rl.check("a").ok).toBe(false);
    rl.reset();
    expect(rl.check("a").ok).toBe(true);
  });
});

describe("concurrency and response shape", () => {
  it("50 concurrent guard calls for one user allow exactly max", async () => {
    setAiRateLimiter(createRateLimiter([{ windowMs: 60_000, max: 7 }]));
    setAiUserResolver(async () => ({ id: "same" }));
    const rs = await Promise.all(Array.from({ length: 50 }, () => guardAiRequest(ENV)));
    expect(rs.filter((r) => r === null)).toHaveLength(7);
    expect(rs.filter((r) => r?.status === 429)).toHaveLength(43);
  });

  it("concurrent distinct users do not interfere", async () => {
    setAiRateLimiter(createRateLimiter([{ windowMs: 60_000, max: 1 }]));
    let i = 0;
    setAiUserResolver(async () => ({ id: `u${i++}` }));
    const rs = await Promise.all(Array.from({ length: 20 }, () => guardAiRequest(ENV)));
    expect(rs.every((r) => r === null)).toBe(true);
  });

  it("429 has Retry-After as digits only, fixed JSON body", async () => {
    const lim: RateLimiter = { check: () => ({ ok: false, retryAfterSec: 42 }), reset() {} };
    setAiRateLimiter(lim);
    setAiUserResolver(async () => ({ id: "u" }));
    const res = (await guardAiRequest(ENV))!;
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("a throwing limiter rejects, never returns null (never fails open)", async () => {
    setAiRateLimiter({
      check: () => {
        throw new Error("lim");
      },
      reset() {},
    });
    setAiUserResolver(async () => ({ id: "u" }));
    await expect(guardAiRequest(ENV)).rejects.toThrow();
  });
});

describe("withAiClient order of checks", () => {
  function counting() {
    const createMessage = vi.fn(async () => ({ content: [], stop_reason: "end_turn" }));
    setAiClientFactory(() => ({ createMessage }) as unknown as AiClient);
    return createMessage;
  }

  it("no key: 503, resolver and limiter untouched", async () => {
    const r = vi.fn(async () => ({ id: "u" }));
    const check = vi.fn(() => ({ ok: true as const }));
    setAiUserResolver(r);
    setAiRateLimiter({ check, reset() {} });
    const res = await withAiClient(async () => new Response("x"), SUPA);
    expect(res.status).toBe(503);
    expect(r).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("signed out: fn never runs, limiter never consulted", async () => {
    const cm = counting();
    const check = vi.fn(() => ({ ok: true as const }));
    setAiUserResolver(async () => null);
    setAiRateLimiter({ check, reset() {} });
    const fn = vi.fn(async () => new Response("x"));
    expect((await withAiClient(fn, ENV)).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(cm).not.toHaveBeenCalled();
  });

  it("a route that throws still consumed one slot (no refund)", async () => {
    const check = vi.fn(() => ({ ok: true as const }));
    setAiUserResolver(async () => ({ id: "u" }));
    setAiRateLimiter({ check, reset() {} });
    counting();
    await expect(
      withAiClient(async () => {
        throw new Error("x");
      }, ENV),
    ).rejects.toThrow();
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("every app/api/ai route is guarded before the body is read", () => {
  const dir = path.resolve(__dirname, "../../../app/api/ai");
  const routes = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it("finds all 13 known routes", () => {
    expect([...routes].sort()).toEqual(
      [
        "ask-coach", "evidence-picks", "generate-routines", "goal-gaps",
        "overload-suggestion", "parse-log", "photo-analysis", "plateau-fix", "review-setup",
        "social-import", "suggest-split", "summary", "swap-exercise",
      ].sort(),
    );
  });

  function spyRequest() {
    const touched: string[] = [];
    const base = new Request("http://x/api/ai/y", { method: "POST", body: "{}" });
    const req = new Proxy(base, {
      get(target, prop) {
        if (["json", "text", "arrayBuffer", "formData", "blob", "body", "bodyUsed", "clone"].includes(String(prop))) {
          touched.push(String(prop));
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    return { req: req as Request, touched };
  }

  function stubSupabase() {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  }

  for (const name of readdirSync(dir)) {
    describe(name, () => {
      const post = async (req: Request) => {
        const mod = await import(`@/app/api/ai/${name}/route`);
        return (await mod.POST(req)) as Response;
      };

      it("signed out: 401, body untouched, model not called", async () => {
        stubSupabase();
        const cm = vi.fn();
        setAiClientFactory(() => ({ createMessage: cm }) as unknown as AiClient);
        setAiUserResolver(async () => null);
        const { req, touched } = spyRequest();
        const res = await post(req);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
        expect(touched).toEqual([]);
        expect(cm).not.toHaveBeenCalled();
      });

      it("over limit: 429 + Retry-After, body untouched, model not called", async () => {
        stubSupabase();
        const cm = vi.fn();
        setAiClientFactory(() => ({ createMessage: cm }) as unknown as AiClient);
        setAiUserResolver(async () => ({ id: "u" }));
        setAiRateLimiter({ check: () => ({ ok: false, retryAfterSec: 9 }), reset() {} });
        const { req, touched } = spyRequest();
        const res = await post(req);
        expect(res.status).toBe(429);
        expect(res.headers.get("Retry-After")).toBe("9");
        expect(touched).toEqual([]);
        expect(cm).not.toHaveBeenCalled();
      });
    });
  }

  it("routes share one limiter: a user's budget is spent across routes", async () => {
    stubSupabase();
    setAiClientFactory(() => ({ createMessage: vi.fn() }) as unknown as AiClient);
    setAiUserResolver(async () => ({ id: "u" }));
    setAiRateLimiter(createRateLimiter([{ windowMs: 60_000, max: 3 }]));
    const statuses: number[] = [];
    for (const name of routes.slice(0, 5)) {
      const mod = await import(`@/app/api/ai/${name}/route`);
      const res: Response = await mod.POST(new Request("http://x", { method: "POST", body: "not json" }));
      statuses.push(res.status);
    }
    expect(statuses.slice(3)).toEqual([429, 429]);
    expect(statuses.slice(0, 3).every((s) => s !== 429 && s !== 401)).toBe(true);
  });
});
