import { test, expect } from "@playwright/test";

// BLK-02: login return-to, push subscription and reminder cron routes. In e2e
// Supabase is blank (local-only mode), so push stays "unavailable" and the
// in-app reminder schedule keeps working; no real push or project is touched.

test("login page renders with a return path and a bad confirmation link shows a plain message", async ({ page }) => {
  await page.goto("/login?next=%2Fsave%3Furl%3Dhttps%253A%252F%252Fyoutu.be%252Fx");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByPlaceholder("Email")).toBeVisible();

  await page.goto("/auth/callback?next=%2Fsave");
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveURL(/\/login\?/);
  await expect(page.getByText("That link did not work.", { exact: false })).toBeVisible();
});

test("push routes are closed without keys or the cron secret", async ({ request }) => {
  const sub = await request.post("/api/push/subscribe", { data: { endpoint: "https://fcm.googleapis.com/fcm/send/x" } });
  expect(sub.status()).toBe(503);
  expect(await sub.json()).toEqual({ unavailable: true });

  const cron = await request.get("/api/cron/reminders");
  expect(cron.status()).toBe(401);
});

test("reminders still explain push is unavailable in local-only mode", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Reminders/ }).click();
  await page.getByRole("button", { name: "Enable notifications" }).click();
  await expect(page.getByText("Push notifications are not set up yet.", { exact: false })).toBeVisible();
});
