import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// middleware.ts with Supabase configured and nobody signed in (mocked client, no network).
vi.mock("@/lib/supabase/configured", () => ({ supabaseConfigured: true }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");

const { middleware } = await import("@/middleware");

const hit = (p: string, method = "POST") => middleware(new NextRequest(new URL(p, "http://localhost:3000"), { method }));

describe("middleware and the feedback route", () => {
  it("answers 401 JSON on /api/feedback, not a login redirect", async () => {
    for (const method of ["POST", "GET"]) {
      const res = await hit("/api/feedback", method);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("never lets a lookalike path through unauthenticated", async () => {
    for (const p of ["/api/feedbackx", "/api/feedback/x"]) {
      const res = await hit(p);
      expect([307, 308]).toContain(res.status);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    }
  });

  it("still answers 401 JSON on AI and push routes", async () => {
    expect((await hit("/api/ai/parse-log")).status).toBe(401);
    expect((await hit("/api/push/subscribe")).status).toBe(401);
  });

  it("still redirects pages to /login", async () => {
    const res = await hit("/profile", "GET");
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});
