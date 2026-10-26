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

const hit = (p: string) => middleware(new NextRequest(new URL(p, "http://localhost:3000")));

describe("middleware login return-to", () => {
  it("sends /save?url=... to /login with next", async () => {
    const res = await hit("/save?url=https%3A%2F%2Fwww.tiktok.com%2F%40a%2Fvideo%2F1");
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe("http://localhost:3000");
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/save?url=https%3A%2F%2Fwww.tiktok.com%2F%40a%2Fvideo%2F1");
    expect([...loc.searchParams.keys()]).toEqual(["next"]);
  });

  it("no next for the home page", async () => {
    const loc = new URL((await hit("/")).headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.search).toBe("");
  });

  it("push subscription API answers 401 JSON instead of a redirect", async () => {
    const res = await hit("/api/push/subscribe");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("the auth callback stays public", async () => {
    const res = await hit("/auth/callback?code=x");
    expect(res.headers.get("location")).toBeNull();
  });
});
