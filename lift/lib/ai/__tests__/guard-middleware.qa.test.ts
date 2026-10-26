import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/configured", () => ({ supabaseConfigured: true }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

const { middleware } = await import("@/middleware");

async function hit(p: string, headers: Record<string, string> = {}) {
  return middleware(new NextRequest(new URL(p, "http://localhost:3000"), { headers }));
}

describe("middleware, signed out, Supabase configured", () => {
  it.each(["/api/ai/summary", "/api/ai/", "/api/ai/x/y", "/api/ai/summary/", "/api/ai/summary?a=/login"])(
    "%s -> 401 JSON",
    async (p) => {
      const res = await hit(p);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    },
  );

  it.each(["/api/ai", "/api/aix", "/api/AI/summary", "/api/ai/../x", "/api/ai%2Fsummary", "/API/ai/summary", "//api/ai/summary"])(
    "%s never passes through unauthenticated",
    async (p) => {
      const res = await hit(p);
      // either 401 or redirect to /login; never plain next()
      expect([307, 308, 401]).toContain(res.status);
      if (res.status !== 401) expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    },
  );

  it("spoofed headers do not authenticate", async () => {
    const res = await hit("/api/ai/summary", {
      authorization: "Bearer anything",
      cookie: "sb-access-token=fake; user=admin",
      "x-user-id": "u1",
      "x-forwarded-for": "127.0.0.1",
      "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware",
    });
    expect(res.status).toBe(401);
  });

  it("cron path with wrong bearer is still refused", async () => {
    const res = await hit("/api/cron/x", { authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });
});
