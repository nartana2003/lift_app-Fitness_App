import { test, expect } from "@playwright/test";

// REM-03: "haven't gone yet" and "behind on weekly goal" nudges are opt-in under
// Profile > Reminders, and the notification's Skip today / Snooze buttons post to
// /api/push/action. The e2e server has no Supabase service-role key, so the
// action route answers 503 unavailable and the cron route stays locked (401).

test("nudge switches are in Profile > Reminders and can be toggled", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Reminders/ }).click();

  const behind = page.getByRole("switch", { name: "You're behind nudge" });
  const smart = page.getByRole("switch", { name: "Smart reminders" });
  await expect(behind).toBeVisible();
  await expect(smart).toBeVisible();
  await expect(page.getByText("On Thursday, if any muscle is short of its weekly set target")).toBeVisible();

  // Smart reminders ("haven't gone yet") is off until the user opts in.
  await expect(smart).toHaveAttribute("aria-checked", "false");
  await smart.click();
  await expect(smart).toHaveAttribute("aria-checked", "true");
  await behind.click();
  await expect(behind).toHaveAttribute("aria-checked", "false");
});

test("Skip / Snooze action route is unavailable without the server keys", async ({ request }) => {
  const res = await request.post("/api/push/action", { data: { action: "skip", token: "x.y" } });
  expect(res.status()).toBe(503);
  expect(await res.json()).toEqual({ unavailable: true });
});

test("reminders cron route is locked without the cron secret", async ({ request }) => {
  const res = await request.get("/api/cron/reminders");
  expect(res.status()).toBe(401);
});
