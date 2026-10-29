import { test, expect } from "@playwright/test";

// QA for GEN-03: with the Generate plan card removed, Home must not overflow
// horizontally at 390px and must raise no page errors.
test("Home without the generate card has no overflow or page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await expect(page.getByText(/Generate \d-day plan/)).toHaveCount(0);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
