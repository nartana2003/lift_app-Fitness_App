import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isCronAuthorized, isCronPath } from "../cronAuth";
import { middleware } from "../../middleware";

const SECRET = "test-cron-secret-123";

describe("isCronPath", () => {
  it("matches /api/cron and its children only", () => {
    expect(isCronPath("/api/cron")).toBe(true);
    expect(isCronPath("/api/cron/reminders")).toBe(true);
    expect(isCronPath("/api/cronjob")).toBe(false);
    expect(isCronPath("/api/ai/summary")).toBe(false);
    expect(isCronPath("/cron")).toBe(false);
  });
});

describe("isCronAuthorized", () => {
  it("accepts only the exact bearer secret", () => {
    expect(isCronAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isCronAuthorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isCronAuthorized(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(isCronAuthorized(SECRET, SECRET)).toBe(false);
    expect(isCronAuthorized(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(isCronAuthorized(null, SECRET)).toBe(false);
    expect(isCronAuthorized("", SECRET)).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    expect(isCronAuthorized("Bearer ", undefined)).toBe(false);
    expect(isCronAuthorized("Bearer ", "")).toBe(false);
    expect(isCronAuthorized("Bearer undefined", undefined)).toBe(false);
  });
});

describe("middleware cron gate", () => {
  afterEach(() => vi.unstubAllEnvs());
  const req = (p: string, auth?: string) =>
    new NextRequest(`http://localhost${p}`, auth ? { headers: { authorization: auth } } : undefined);

  it("rejects cron calls without the secret, even in local-only mode", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await middleware(req("/api/cron/reminders"))).status).toBe(401);
    expect((await middleware(req("/api/cron/reminders", "Bearer wrong"))).status).toBe(401);
  });

  it("rejects every cron call when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await middleware(req("/api/cron", "Bearer "))).status).toBe(401);
  });

  it("lets a call with the right secret through", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await middleware(req("/api/cron/reminders", `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("leaves other routes alone in local-only mode", async () => {
    const res = await middleware(req("/progress"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("service worker API calls", () => {
  const root = path.resolve(__dirname, "../..");
  const sw = readFileSync(path.join(root, "public/sw.js"), "utf8");

  it("no longer posts to the missing snooze route", () => {
    expect(sw).not.toContain("/api/reminders/snooze");
  });

  it("only calls /api routes that exist in app/api", () => {
    const calls = [...sw.matchAll(/["'`](\/api\/[\w\-/]+)["'`]/g)].map((m) => m[1]);
    for (const call of calls) {
      const dir = path.join(root, "app", call);
      const exists = (() => {
        try {
          return statSync(dir).isDirectory() && readdirSync(dir).some((f) => /^route\.(ts|js)$/.test(f));
        } catch {
          return false;
        }
      })();
      expect(exists, `${call} has no route handler`).toBe(true);
    }
  });
});
