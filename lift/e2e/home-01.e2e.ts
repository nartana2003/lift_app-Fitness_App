import { test, expect } from "@playwright/test";

// HOME-01: the collapsed Today's exercises subtitle. With nothing starred the
// Push day hints "star exercises to get picks"; after starring a Chest exercise
// it counts the picks instead. All local (Dexie); no Supabase or AI key needed.

test("Today's exercises subtitle hints at starring, then counts picks", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const card = page.getByRole("button", { name: /Today's exercises/ });
  await expect(card).toBeVisible();
  await card.click();
  await page.getByRole("button", { name: "Use Push / Pull / Legs" }).click();
  await expect(page.getByRole("combobox", { name: "Split day" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Star some exercises for Chest to build your pool" })).toBeVisible();

  // Collapse: the subtitle shows the hint, not "0 exercises".
  await card.click();
  await expect(card).toContainText("star exercises to get picks");
  await expect(card).not.toContainText("0 exercises");

  await page.goto("/exercises?m=Chest");
  await page.waitForLoadState("networkidle");
  const star = page.getByRole("button", { name: "Add to favorites" }).first();
  await expect(star).toBeVisible();
  await star.click();
  await expect(page.getByRole("button", { name: "Remove from favorites" }).first()).toBeVisible();

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const again = page.getByRole("button", { name: /Today's exercises/ });
  await expect(again).toContainText(/1 exercise/);
  await expect(again).not.toContainText("star exercises to get picks");
});
