import { test, expect } from "@playwright/test";

// BLK-04: the Sync and Account tiles were removed from Profile. Sign out is a
// plain button at the bottom (only when signed in; Supabase is blank in e2e).

test("Profile has no Backup, Sync or Account tile", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: /^Import data/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Backup/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Sync/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Account/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
});
