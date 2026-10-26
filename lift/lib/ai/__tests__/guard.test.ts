import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAiClientFactory, type AiClient, type AiMessage, type AiParams } from "../client";
import {
  AI_RATE_LIMITS,
  aiRateLimited,
  aiUnauthorized,
  createRateLimiter,
  guardAiRequest,
  setAiRateLimiter,
  setAiUserResolver,
  supabaseConfiguredFrom,
  type AiUser,
} from "../guard";
import { withAiClient } from "../respond";

const SUPA = { NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" };
const KEY = { ANTHROPIC_API_KEY: "test-key" };

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function fakeClient() {
  const calls: AiParams[] = [];
  const client: AiClient = {
    createMessage: async (p) => {
      calls.push(p);
      return { content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" } as unknown as AiMessage;
    },
  };
  setAiClientFactory(() => client);
  return calls;
}

function resolverReturning(user: AiUser | null) {
  const fn = vi.fn(async () => user);
  setAiUserResolver(fn);
  return fn;
}

afterEach(() => {
  setAiUserResolver(null);
  setAiRateLimiter(null);
  setAiClientFactory(null);
  vi.unstubAllEnvs();
});

describe("supabaseConfiguredFrom", () => {
  it("needs both a real URL and an anon key", () => {
    expect(supabaseConfiguredFrom(SUPA)).toBe(true);
    expect(supabaseConfiguredFrom({})).toBe(false);
    expect(supabaseConfiguredFrom({ NEXT_PUBLIC_SUPABASE_URL: SUPA.NEXT_PUBLIC_SUPABASE_URL })).toBe(false);
    expect(supabaseConfiguredFrom({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" })).toBe(false);
    expect(
      supabaseConfiguredFrom({ NEXT_PUBLIC_SUPABASE_URL: "https://YOUR-PROJECT.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" }),
    ).toBe(false);
  });
});

describe("createRateLimiter", () => {
  it("allows up to max per window, then blocks with a Retry-After", () => {
    const c = clock();
    const rl = createRateLimiter([{ windowMs: 60_000, max: 3 }], c.now);
    expect(rl.check("u1")).toEqual({ ok: true });
    c.advance(10_000);
    expect(rl.check("u1")).toEqual({ ok: true });
    expect(rl.check("u1")).toEqual({ ok: true });
    // Oldest call was at t0; it expires 50s from now.
    expect(rl.check("u1")).toEqual({ ok: false, retryAfterSec: 50 });
  });

  it("frees a slot once the oldest call leaves the window", () => {
    const c = clock();
    const rl = createRateLimiter([{ windowMs: 60_000, max: 2 }], c.now);
    rl.check("u1");
    c.advance(30_000);
    rl.check("u1");
    expect(rl.check("u1").ok).toBe(false);
    c.advance(30_000);
    expect(rl.check("u1")).toEqual({ ok: true });
    expect(rl.check("u1").ok).toBe(false);
  });

  it("counts each user separately", () => {
    const c = clock();
    const rl = createRateLimiter([{ windowMs: 60_000, max: 1 }], c.now);
    expect(rl.check("u1").ok).toBe(true);
    expect(rl.check("u1").ok).toBe(false);
    expect(rl.check("u2").ok).toBe(true);
  });

  it("does not count blocked calls, so hammering does not extend the wait", () => {
    const c = clock();
    const rl = createRateLimiter([{ windowMs: 10_000, max: 1 }], c.now);
    rl.check("u1");
    for (let i = 0; i < 50; i++) {
      c.advance(100);
      expect(rl.check("u1").ok).toBe(false);
    }
    c.advance(5_000);
    expect(rl.check("u1").ok).toBe(true);
  });

  it("applies every window: the longer one blocks after the short one resets", () => {
    const c = clock();
    const rl = createRateLimiter(
      [
        { windowMs: 1_000, max: 2 },
        { windowMs: 60_000, max: 3 },
      ],
      c.now,
    );
    expect(rl.check("u").ok).toBe(true);
    expect(rl.check("u").ok).toBe(true);
    expect(rl.check("u")).toEqual({ ok: false, retryAfterSec: 1 });
    c.advance(1_000);
    expect(rl.check("u").ok).toBe(true);
    c.advance(1_000);
    // Short window is clear, the 60s window is full (3 calls since t0).
    expect(rl.check("u")).toEqual({ ok: false, retryAfterSec: 58 });
  });

  it("caps the number of tracked users by dropping the least recent", () => {
    const c = clock();
    const rl = createRateLimiter([{ windowMs: 60_000, max: 1 }], c.now, 2);
    rl.check("a");
    rl.check("b");
    rl.check("c"); // evicts "a"
    expect(rl.check("a").ok).toBe(true);
    expect(rl.check("c").ok).toBe(false);
  });

  it("keeps Retry-After within the window after the clock goes backwards", () => {
    const c = clock(50_000);
    const rl = createRateLimiter([{ windowMs: 1_000, max: 2 }], c.now);
    rl.check("u");
    rl.check("u");
    c.advance(-49_000);
    const r = rl.check("u");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSec).toBeLessThanOrEqual(1);
    c.advance(1_000);
    expect(rl.check("u").ok).toBe(true);
  });

  it("reset() clears every count", () => {
    const rl = createRateLimiter([{ windowMs: 60_000, max: 1 }], clock().now);
    rl.check("u");
    expect(rl.check("u").ok).toBe(false);
    rl.reset();
    expect(rl.check("u").ok).toBe(true);
  });

  it("default limits are positive and sane", () => {
    expect(AI_RATE_LIMITS.length).toBeGreaterThan(0);
    for (const l of AI_RATE_LIMITS) {
      expect(l.max).toBeGreaterThan(0);
      expect(l.windowMs).toBeGreaterThan(0);
    }
  });
});

describe("fixed responses", () => {
  it("401 and 429 have fixed JSON bodies", async () => {
    const u = aiUnauthorized();
    expect(u.status).toBe(401);
    expect(await u.json()).toEqual({ error: "unauthorized" });
    const r = aiRateLimited(42);
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("42");
    expect(await r.json()).toEqual({ error: "rate_limited" });
  });
});

describe("guardAiRequest", () => {
  it("lets everything through in local-only mode without looking up a user", async () => {
    const fn = resolverReturning(null);
    expect(await guardAiRequest({})).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("answers 401 JSON when Supabase is configured and nobody is signed in", async () => {
    resolverReturning(null);
    const res = await guardAiRequest(SUPA);
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: "unauthorized" });
  });

  it("fails closed when the session lookup throws", async () => {
    setAiUserResolver(async () => {
      throw new Error("network down");
    });
    const res = await guardAiRequest(SUPA);
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a user with an empty id", async () => {
    resolverReturning({ id: "" });
    expect((await guardAiRequest(SUPA))?.status).toBe(401);
    resolverReturning({ id: "  \t " });
    expect((await guardAiRequest(SUPA))?.status).toBe(401);
  });

  it("lets a signed-in user through, then rate-limits that user only", async () => {
    const c = clock();
    setAiRateLimiter(createRateLimiter([{ windowMs: 60_000, max: 2 }], c.now));
    resolverReturning({ id: "user-1" });
    expect(await guardAiRequest(SUPA)).toBeNull();
    expect(await guardAiRequest(SUPA)).toBeNull();
    const res = await guardAiRequest(SUPA);
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBe("60");
    expect(await res?.json()).toEqual({ error: "rate_limited" });

    resolverReturning({ id: "user-2" });
    expect(await guardAiRequest(SUPA)).toBeNull();
  });
});

describe("withAiClient", () => {
  it("answers 503 before any auth lookup when there is no key", async () => {
    const fn = resolverReturning(null);
    const inner = vi.fn(async () => new Response("ok"));
    const res = await withAiClient(inner, { ...SUPA });
    expect(res.status).toBe(503);
    expect(fn).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it("answers 401 and never runs the route when signed out", async () => {
    const calls = fakeClient();
    resolverReturning(null);
    const inner = vi.fn(async () => new Response("ok"));
    const res = await withAiClient(inner, { ...SUPA, ...KEY });
    expect(res.status).toBe(401);
    expect(inner).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("answers 429 and never runs the route when over the limit", async () => {
    fakeClient();
    setAiRateLimiter(createRateLimiter([{ windowMs: 60_000, max: 1 }], clock().now));
    resolverReturning({ id: "u" });
    const inner = vi.fn(async () => new Response("ok"));
    expect((await withAiClient(inner, { ...SUPA, ...KEY })).status).toBe(200);
    expect((await withAiClient(inner, { ...SUPA, ...KEY })).status).toBe(429);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("runs the route for a signed-in user", async () => {
    fakeClient();
    resolverReturning({ id: "u" });
    const res = await withAiClient(async () => Response.json({ fine: true }), { ...SUPA, ...KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fine: true });
  });

  it("keeps working with no accounts in local-only mode", async () => {
    fakeClient();
    const fn = resolverReturning(null);
    const res = await withAiClient(async () => Response.json({ fine: true }), { ...KEY });
    expect(res.status).toBe(200);
    expect(fn).not.toHaveBeenCalled();
  });
});

// Every route under app/api/ai goes through withAiClient, so every one must
// answer 401 when signed out and 429 when over the limit, without reading the
// body or calling the model.
const AI_DIR = path.resolve(__dirname, "../../../app/api/ai");
const ROUTES = readdirSync(AI_DIR).filter((d) => existsSync(path.join(AI_DIR, d, "route.ts")));

describe("every /api/ai/* route", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPA.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", SUPA.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    vi.stubEnv("ANTHROPIC_API_KEY", KEY.ANTHROPIC_API_KEY);
  });

  it("finds the routes", () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(14);
  });

  it.each(ROUTES)("%s: 401 JSON when signed out, model never called", async (name) => {
    const calls = fakeClient();
    resolverReturning(null);
    const mod = (await import(path.join(AI_DIR, name, "route.ts"))) as { POST: (r: Request) => Promise<Response> };
    const req = new Request(`http://localhost/api/ai/${name}`, { method: "POST", body: "not json" });
    const res = await mod.POST(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(req.bodyUsed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each(ROUTES)("%s: 429 when the user is over the limit", async (name) => {
    const calls = fakeClient();
    resolverReturning({ id: "busy-user" });
    setAiRateLimiter({ check: () => ({ ok: false, retryAfterSec: 7 }), reset: () => {} });
    const mod = (await import(path.join(AI_DIR, name, "route.ts"))) as { POST: (r: Request) => Promise<Response> };
    const req = new Request(`http://localhost/api/ai/${name}`, { method: "POST", body: "not json" });
    const res = await mod.POST(req);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    expect(req.bodyUsed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each(ROUTES)("%s: signed-in user under the limit reaches the route (bad body is 400)", async (name) => {
    fakeClient();
    resolverReturning({ id: "ok-user" });
    const mod = (await import(path.join(AI_DIR, name, "route.ts"))) as { POST: (r: Request) => Promise<Response> };
    const res = await mod.POST(new Request(`http://localhost/api/ai/${name}`, { method: "POST", body: "not json" }));
    expect(res.status).toBe(400);
  });
});
