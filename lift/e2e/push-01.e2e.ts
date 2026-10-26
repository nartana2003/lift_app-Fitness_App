import { test, expect } from "@playwright/test";

// PUSH-01: rest-timer push. In e2e Supabase and VAPID are blank (local-only
// mode), so the route answers 503 and the toggle explains that the in-app
// timer is the alert. No real push is ever sent.

test("rest-timer route is closed without keys", async ({ request }) => {
  const res = await request.post("/api/rest-timer", {
    data: { endpoint: "https://fcm.googleapis.com/fcm/send/x", delaySec: 90 },
  });
  expect(res.status()).toBe(503);
  expect(await res.json()).toEqual({ unavailable: true });
});

test("rest timer alerts toggle falls back to the in-app timer", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Reminders/ }).click();
  const toggle = page.getByRole("switch", { name: "Rest timer alerts" });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByText("Rest timer alerts need push notifications", { exact: false })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});
