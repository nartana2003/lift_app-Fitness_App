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

const post = (p: string) => middleware(new NextRequest(new URL(p, "http://localhost:3000"), { method: "POST" }));

describe("middleware and the notification action route", () => {
  it("lets /api/push/action through without a session (the route checks the signed token)", async () => {
    const res = await post("/api/push/action");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still answers 401 JSON on the subscription route", async () => {
    const res = await post("/api/push/subscribe");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("still answers 401 JSON on AI routes", async () => {
    expect((await post("/api/ai/ask-coach")).status).toBe(401);
  });

  it("exempts only the exact /api/push/action path, not paths that start with it", async () => {
    for (const p of ["/api/push/action-x", "/api/push/actions", "/api/push/action/anything"]) {
      const res = await post(p);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });
});
