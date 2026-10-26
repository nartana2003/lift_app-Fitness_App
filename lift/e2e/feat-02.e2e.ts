import { test, expect } from "@playwright/test";

// FEAT-02: skip statistics in the This week / This month snapshot on Progress.
// Fresh browser context, no Supabase and no AI key: nothing is planned, so the
// card shows the empty skip message for both periods.

test("snapshot shows the skipped workouts section for week and month", async ({ page }) => {
  await page.goto("/progress");
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { name: "Skipped workouts" })).toBeVisible();
  await expect(page.getByText("No skipped or moved workouts this week.")).toBeVisible();

  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page.getByRole("heading", { name: "This month" })).toBeVisible();
  await expect(page.getByText("No skipped or moved workouts this month.")).toBeVisible();
});
