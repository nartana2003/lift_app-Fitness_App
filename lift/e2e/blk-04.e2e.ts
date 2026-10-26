import { test, expect } from "@playwright/test";

// BLK-04: Profile > Sync card. In e2e Supabase is blank (local-only mode), so
// the card says sync is off and lists nothing; no live service is touched.

test("Profile shows a collapsed Sync card that opens to the local-only message", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  const header = page.getByRole("button", { name: /^Sync/ });
  await expect(header).toBeVisible();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(header).toContainText("Local only");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Sync is off. Everything is stored on this device.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resend all" })).toHaveCount(0);
});
