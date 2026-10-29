import { test, expect } from "@playwright/test";

// GEN-03: the Generate plan card (Favourites, Tell the coach, Build a split)
// was removed from Home. Home keeps the manual routine flow.
test("Home does not show the generate plan card", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("link", { name: "New routine" })).toBeVisible();
  await expect(page.getByText(/Generate \d-day plan/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Favourites", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tell the coach", exact: true })).toHaveCount(0);
});
