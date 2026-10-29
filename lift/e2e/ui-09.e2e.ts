import { test, expect } from "@playwright/test";

// UI-09: the "Save from link" card was removed from Home. The /save page still
// works (see soc-02) and the manual routine flow is still there.
test("Home no longer shows Save from link", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("link", { name: "New routine" })).toBeVisible();
  await expect(page.getByText("Save from link")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Paste link" })).toHaveCount(0);
});
