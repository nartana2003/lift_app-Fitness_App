import { test, expect } from "@playwright/test";

// UI-04: coach recap inside the This week / This month card on Progress.
// There is no AI key in e2e, so tapping "Get recap" must show a plain
// unavailable/failure note while the rule-based stats stay in place.
test("period card shows a plain note when the coach recap is unavailable", async ({ page }) => {
  await page.goto("/progress");
  await page.waitForLoadState("networkidle"); // let React hydrate before clicking

  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "This week" }) });
  await expect(card.getByRole("heading", { name: "Coach recap" })).toBeVisible();
  await expect(card.getByText("workouts", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: "Get recap" }).click();
  await expect(
    card.getByText(/coach recap is not available right now|Could not get the coach recap|coach recap is available when back online/),
  ).toBeVisible();
  await expect(card.getByRole("list", { name: "Overload advice" })).toHaveCount(0);

  // Switching to Month keeps the rule-based card and resets the recap.
  await card.getByRole("button", { name: "Month" }).click();
  const month = page.locator("section").filter({ has: page.getByRole("heading", { name: "This month" }) });
  await expect(month.getByRole("button", { name: "Get recap" })).toBeVisible();
  await expect(month.getByText("workouts", { exact: true })).toBeVisible();
});
