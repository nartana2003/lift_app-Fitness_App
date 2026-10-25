import { test, expect } from "@playwright/test";

// WEEK-01: the This Week strip shows each day as a round circle. Tapping an
// unmarked date from today on marks it as a gym day (solid black) and opens
// the day panel; the mark is stored locally (Dexie), so it survives a reload.
// No Supabase and no AI key are needed.

test("tap a date to mark it a gym day; it stays marked after reload and is round", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();

  // The first markable date is today (past dates cannot be marked).
  const first = page.getByRole("button", { name: /not a gym day, tap to mark$/ }).first();
  await expect(first).toBeVisible();
  const day = await first.getAttribute("data-day");
  expect(day).toBeTruthy();
  const circle = page.locator(`button[data-day="${day}"]`);

  // Round: equal width and height, at least 40px, fully rounded corners.
  const shape = await circle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { w: r.width, h: r.height, radius: parseFloat(cs.borderTopLeftRadius) };
  });
  expect(Math.abs(shape.w - shape.h)).toBeLessThan(1);
  expect(shape.w).toBeGreaterThanOrEqual(40);
  expect(shape.radius).toBeGreaterThanOrEqual(shape.w / 2);

  await circle.click();
  await expect(circle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Gym day: on" })).toBeVisible();
  // Filled black (the accent).
  const bg = await circle.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(17, 17, 17)");
  await page.screenshot({ path: "test-results/week-01-marked.png" });

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.locator(`button[data-day="${day}"]`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`button[data-day="${day}"]`)).toHaveAccessibleName(/gym day, tap to change$/);
});
