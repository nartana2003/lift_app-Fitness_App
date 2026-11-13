import { test, expect } from "@playwright/test";

// The This week / This month card on Progress has no AI coach recap: it shows the
// rule-based stats only, for both periods.
test("period card shows the rule-based stats and no coach recap", async ({ page }) => {
  await page.goto("/progress");
  await page.waitForLoadState("networkidle"); // let React hydrate before clicking

  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "This week" }) });
  await expect(card.getByText("workouts", { exact: true })).toBeVisible();
  await expect(page.getByText("Coach recap")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Get recap" })).toHaveCount(0);

  await card.getByRole("button", { name: "Month" }).click();
  const month = page.locator("section").filter({ has: page.getByRole("heading", { name: "This month" }) });
  await expect(month.getByText("workouts", { exact: true })).toBeVisible();
  await expect(page.getByText("Coach recap")).toHaveCount(0);
});
