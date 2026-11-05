import { test, expect } from "@playwright/test";

// Issue #2: the "Auto-fill from my split" option was removed from the Home week
// strip. The strip itself still renders and days can still be tapped and planned.

test("Home week strip has no auto-fill option", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
  await expect(page.getByRole("button", { name: /auto-fill/i })).toHaveCount(0);
});
