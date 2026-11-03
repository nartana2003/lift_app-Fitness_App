import { test, expect } from "@playwright/test";

// CRON-01: the weekly plateau check and the monthly photo analysis and target
// re-check run from Vercel Cron with `Authorization: Bearer <CRON_SECRET>`. The
// e2e server has no CRON_SECRET and no keys, so every call is locked (401).

const ROUTES = ["/api/cron/plateaus", "/api/cron/photo-analysis", "/api/cron/target-recheck"];

for (const route of ROUTES) {
  test(`${route} is locked without the cron secret`, async ({ request }) => {
    const none = await request.get(route);
    expect(none.status()).toBe(401);
    expect(await none.json()).toEqual({ error: "unauthorized" });

    const wrong = await request.get(route, { headers: { authorization: "Bearer wrong-secret" } });
    expect(wrong.status()).toBe(401);
    expect(wrong.status()).not.toBe(200);
  });
}
