import { test, expect } from "@playwright/test";

// POOL-02: star a Chest exercise on the Exercises screen, then open the Today's
// exercises card on Home, pick the Push / Pull / Legs split (day 1 is Push, with
// no history) and see the starred exercise suggested. Rule-based, all local
// (Dexie); no Supabase and no AI key are needed.

test("a starred exercise is suggested in Today's exercises", async ({ page }) => {
  await page.goto("/exercises?m=Chest");
  await page.waitForLoadState("networkidle");

  const star = page.getByRole("button", { name: "Add to favorites" }).first();
  await expect(star).toBeVisible();
  // The exercise name is the card's heading next to the star.
  const name = (await page.locator("li", { has: star }).first().locator("h3").innerText()).trim();
  expect(name.length).toBeGreaterThan(0);
  await star.click();
  await expect(page.getByRole("button", { name: "Remove from favorites" }).first()).toBeVisible();

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const card = page.getByRole("button", { name: /Today's exercises/ });
  await expect(card).toBeVisible();
  await card.click();

  await page.getByRole("button", { name: "Use Push / Pull / Legs" }).click();
  await expect(page.getByRole("combobox", { name: "Split day" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chest", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name, exact: true }).first()).toBeChecked();
  await expect(page.getByRole("button", { name: "Start workout", exact: true })).toBeEnabled();
});
