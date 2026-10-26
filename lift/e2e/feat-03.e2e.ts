import { test, expect } from "@playwright/test";

// FEAT-03: "Auto-fill from my split" on the Home week strip. Fresh browser
// context with no Supabase and no AI key: there are no routines yet, so the
// panel asks for one and Cancel closes it. The strip itself still renders.

test("auto-fill panel opens on Home and asks for a routine first", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
  await page.getByRole("button", { name: "Auto-fill from my split" }).click();
  await expect(page.getByText("Create a routine first to auto-fill your week.")).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Create a routine first to auto-fill your week.")).toHaveCount(0);
});
