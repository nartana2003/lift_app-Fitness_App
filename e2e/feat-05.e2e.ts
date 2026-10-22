import { test, expect } from "@playwright/test";

// FEAT-05: Reminders section in Profile. No Supabase and no push server in e2e,
// so "Enable notifications" shows the plain unavailable message while the
// schedule itself is saved on the device.

test("reminders section picks a day and explains push is unavailable", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");

  const header = page.getByRole("button", { name: /^Reminders/ });
  await expect(header).toBeVisible();
  await expect(header).toContainText("Off");
  await header.click();

  await expect(page.getByText("Pick at least one gym day to get reminders.")).toBeVisible();
  const wed = page.getByRole("checkbox", { name: "Wed" });
  await wed.click();
  await expect(wed).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Next reminder")).toBeVisible();

  await page.getByRole("button", { name: "Enable notifications" }).click();
  await expect(page.getByText("Push notifications are not set up yet.", { exact: false })).toBeVisible();
});
