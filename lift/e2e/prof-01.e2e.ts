import { test, expect } from "@playwright/test";

// PROF-01: personal details survive a reload. Blank Supabase, so this is the
// local-only path: the load is trusted, autosave runs after an edit, and the
// values come back from the device copy. No "could not be loaded" note.

test("profile details autosave locally and come back after a reload", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Personal information/ }).click();
  await expect(page.getByText("Your saved profile could not be loaded yet.", { exact: false })).toHaveCount(0);

  await page.getByLabel("Name").fill("Nat Tester");
  await page.getByLabel("Mobile phone").fill("+1 555 0100");
  await page.getByRole("button", { name: "Female" }).click();
  await page.getByLabel(/^Date of birth/).fill("1995-04-02");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Nat Tester").first()).toBeVisible();
  await page.getByRole("button", { name: /^Personal information/ }).click();
  await expect(page.getByLabel("Name")).toHaveValue("Nat Tester");
  await expect(page.getByLabel("Mobile phone")).toHaveValue("+1 555 0100");
  await expect(page.getByLabel(/^Date of birth/)).toHaveValue("1995-04-02");
  await expect(page.getByRole("button", { name: "Female" })).toHaveClass(/chip-on/);
});
