import { test, expect, type Page } from "@playwright/test";

// Start Workout / Resume workout is a floating pill at the bottom right of Home,
// just above the tab bar, and stays put while the page scrolls (Lyfta style).

async function home(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
}

async function expectFloatingAboveTabBar(page: Page, name: string, role: "button" | "link", viewportWidth: number) {
  const fab = page.getByRole(role, { name });
  await expect(fab).toBeVisible();
  const box = (await fab.boundingBox())!;
  const nav = (await page.getByRole("navigation").boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(nav.y);
  expect(nav.y - (box.y + box.height)).toBeLessThan(40);
  // Right aligned inside the 32rem content column, not full width.
  const columnRight = viewportWidth >= 512 ? (viewportWidth + 512) / 2 : viewportWidth;
  expect(box.x + box.width).toBeLessThanOrEqual(columnRight);
  expect(box.x + box.width).toBeGreaterThan(columnRight - 24);
  expect(box.width).toBeLessThan(columnRight * 0.75);
  return box;
}

test("Start Workout floats bottom right above the tab bar and stays while scrolling", async ({ page }) => {
  await home(page);
  const before = await expectFloatingAboveTabBar(page, "Start Workout", "button", 390);
  await expect(page.getByRole("button", { name: "Start Workout" }).locator("..")).toHaveCSS("position", "fixed");

  await page.evaluate(() => {
    document.body.style.minHeight = "3000px";
    window.scrollTo(0, 1500);
  });
  const after = (await page.getByRole("button", { name: "Start Workout" }).boundingBox())!;
  expect(after.y).toBeCloseTo(before.y, 0);
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test("tapping the floating button starts a workout, and Home then floats Resume workout", async ({ page }) => {
  await home(page);
  await page.getByRole("button", { name: "Start Workout" }).click();
  await expect(page).toHaveURL(/\/workout$/);

  await home(page);
  await expect(page.getByRole("button", { name: "Start Workout" })).toHaveCount(0);
  await expectFloatingAboveTabBar(page, "Resume workout", "link", 390);
  await page.getByRole("link", { name: "Resume workout" }).click();
  await expect(page).toHaveURL(/\/workout$/);
});

test("on desktop the button stays inside the centred content column", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await home(page);
  await expectFloatingAboveTabBar(page, "Start Workout", "button", 1280);
});
