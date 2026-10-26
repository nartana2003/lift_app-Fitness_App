/**
 * Server-only. Sign-in check and per-user rate limit for every app/api/ai/*
 * route. withAiClient (lib/ai/respond.ts) calls guardAiRequest() after the key
 * check and before the route reads its body, so no route can skip it.
 *
 * - Supabase configured: the caller must be signed in, else 401
 *   {error:"unauthorized"}. A failing auth lookup also answers 401 (fail closed).
 * - Supabase not configured (local-only mode, same rule as middleware.ts):
 *   there are no accounts, so neither check applies.
 * - Signed in: at most AI_RATE_LIMITS calls per window per user id, else 429
 *   {error:"rate_limited"} with a Retry-After header.
 *
 * The limiter is in memory, so on a multi-instance deployment each instance
 * counts separately. It still caps a single user's burst against one instance.
 * Tests swap the user lookup with setAiUserResolver(); no real Supabase call.
 */
import type { AiEnv } from "./configured";

export type AiUser = { id: string };

/** Resolves the signed-in user for the current request, or null. */
export type AiUserResolver = () => Promise<AiUser | null>;

export type AiUnauthorizedBody = { error: "unauthorized" };

/** Calls allowed per user in each window. All windows must have room. */
export const AI_RATE_LIMITS: readonly { windowMs: number; max: number }[] = [
  { windowMs: 60_000, max: 30 },
  { windowMs: 24 * 60 * 60_000, max: 300 },
];

/** Upper bound on tracked users, so the map cannot grow without limit. */
export const AI_RATE_LIMIT_MAX_KEYS = 10_000;

/** Server-side twin of lib/supabase/configured.ts, reading the given env. */
export function supabaseConfiguredFrom(env: AiEnv): boolean {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  return Boolean(url && env.NEXT_PUBLIC_SUPABASE_ANON_KEY && !url.includes("YOUR-PROJECT"));
}

/** Default lookup: the Supabase session from the request cookies. */
export const supabaseUserResolver: AiUserResolver = async () => {
  const { supabaseServer } = await import("../supabase/server");
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.id) return null;
  return { id: data.user.id };
};

let resolver: AiUserResolver = supabaseUserResolver;

/** Test seam: swap in a fake user lookup; pass null to restore Supabase. */
export function setAiUserResolver(next: AiUserResolver | null): void {
  resolver = next ?? supabaseUserResolver;
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

export interface RateLimiter {
  check(key: string): RateLimitResult;
  reset(): void;
}

/**
 * Sliding-window limiter. A call is counted only when it is allowed, so a
 * client hammering a full window does not push its own reset further out.
 */
export function createRateLimiter(
  limits: readonly { windowMs: number; max: number }[] = AI_RATE_LIMITS,
  now: () => number = Date.now,
  maxKeys: number = AI_RATE_LIMIT_MAX_KEYS,
): RateLimiter {
  const longest = Math.max(...limits.map((l) => l.windowMs));
  const hits = new Map<string, number[]>();

  return {
    check(key) {
      const t = now();
      // Clamp hits recorded "in the future" (the clock was set back) to now, so
      // Retry-After can never exceed the window.
      const kept = (hits.get(key) ?? []).map((h) => Math.min(h, t)).filter((h) => t - h < longest);
      let retryMs = 0;
      for (const { windowMs, max } of limits) {
        const inWindow = kept.filter((h) => t - h < windowMs);
        if (inWindow.length >= max) {
          // The window frees a slot when its oldest counted call expires.
          const oldest = inWindow[inWindow.length - max];
          retryMs = Math.max(retryMs, oldest + windowMs - t);
        }
      }
      if (retryMs > 0) {
        hits.set(key, kept);
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)) };
      }
      kept.push(t);
      hits.delete(key); // re-insert so Map order tracks recent use
      hits.set(key, kept);
      while (hits.size > maxKeys) {
        const first = hits.keys().next().value;
        if (first === undefined) break;
        hits.delete(first);
      }
      return { ok: true };
    },
    reset() {
      hits.clear();
    },
  };
}

let limiter: RateLimiter = createRateLimiter();

/** Test seam: swap the limiter; pass null for a fresh default one. */
export function setAiRateLimiter(next: RateLimiter | null): void {
  limiter = next ?? createRateLimiter();
}

/** 401 {error:"unauthorized"}: AI needs a signed-in user. */
export function aiUnauthorized(): Response {
  return Response.json({ error: "unauthorized" } satisfies AiUnauthorizedBody, { status: 401 });
}

/** 429 {error:"rate_limited"} with Retry-After in seconds. */
export function aiRateLimited(retryAfterSec: number): Response {
  return Response.json(
    { error: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

/**
 * null when the request may go ahead, else the response to send instead
 * (401 not signed in, 429 over the limit).
 */
export async function guardAiRequest(env: AiEnv = process.env): Promise<Response | null> {
  if (!supabaseConfiguredFrom(env)) return null; // local-only mode: no accounts
  let user: AiUser | null;
  try {
    user = await resolver();
  } catch {
    user = null;
  }
  if (!user || typeof user.id !== "string" || user.id.trim().length === 0) return aiUnauthorized();
  const limited = limiter.check(user.id);
  if (!limited.ok) return aiRateLimited(limited.retryAfterSec);
  return null;
}
