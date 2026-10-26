import { test, expect } from "@playwright/test";

// REM-02: Profile > Reminders suggests the usual workout start time once there
// are at least 5 workouts. A fresh browser has no workouts, so no suggestion is
// shown and the saved reminder time is left alone. Local only, no AI, no push.

test("no smart time suggestion without workout history; reminder time still editable", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Reminders/ }).click();
  await expect(page.getByText("Reminders follow the days you mark on the This Week strip.")).toBeVisible();
  await expect(page.getByLabel("Reminder time")).toHaveValue("18:00");
  await expect(page.getByText(/You usually start around/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Use \d\d:\d\d$/ })).toHaveCount(0);

  await page.getByLabel("Reminder time").fill("07:30");
  await expect(page.getByLabel("Reminder time")).toHaveValue("07:30");
  await expect(page.getByRole("switch", { name: "Smart reminders" })).toBeVisible();
});
