import { test, expect } from "@playwright/test";

// REM-01: reminders follow the dates marked on the This Week strip, with no
// usual weekdays picked. Everything is local (Dexie); no Supabase, no AI key.

test("marking a date on the This Week strip gives a next reminder in Profile", async ({ page }) => {
  // A late reminder time, so a mark on today is still ahead of now.
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Reminders/ }).click();
  await expect(page.getByText("Reminders follow the days you mark on the This Week strip.")).toBeVisible();
  await expect(page.getByText("Pick at least one gym day to get reminders.")).toBeVisible();
  await page.getByLabel("Reminder time").fill("23:59");
  await expect(page.getByLabel("Reminder time")).toHaveValue("23:59");

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  // The first markable date is today (past dates cannot be marked).
  const first = page.getByRole("button", { name: /not a gym day, tap to mark$/ }).first();
  await expect(first).toBeVisible();
  const day = await first.getAttribute("data-day");
  await first.click();
  await expect(page.locator(`button[data-day="${day}"]`)).toHaveAttribute("aria-pressed", "true");

  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Reminders/ }).click();
  await expect(page.getByText("Next reminder")).toBeVisible();
  await expect(page.getByText("Pick at least one gym day to get reminders.")).toHaveCount(0);
});
