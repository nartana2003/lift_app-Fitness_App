import { test, expect, type Page } from "@playwright/test";

// CO-00: Coach is its own tab (Home, Exercises, Coach, Progress, Profile). Goals,
// My split and Ask the coach live there; Profile keeps a link to them.

const nav = (page: Page) => page.getByRole("navigation");

test("the Coach tab opens Goals, My split and Ask the coach, and Profile links to it", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(nav(page).getByRole("link")).toHaveText(["Home", "Exercises", "Coach", "Progress", "Profile"]);

  await nav(page).getByRole("link", { name: "Coach" }).click();
  await expect(page).toHaveURL(/\/coach$/);
  await expect(page.getByRole("heading", { name: "Coach" })).toBeVisible();
  for (const name of ["Goals", "My split", "Ask the coach"]) {
    await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await expect(nav(page).getByRole("link", { name: "Coach" })).toHaveClass(/font-semibold/);

  // Goals open and work from here.
  await page.getByRole("button", { name: /^Goals/ }).click();
  await expect(page.locator("button.chip", { hasText: /^Chest$/ }).first()).toBeVisible();

  await nav(page).getByRole("link", { name: "Profile" }).click();
  await expect(page).toHaveURL(/\/profile$/);
  for (const name of ["Goals", "My split", "Ask the coach"]) {
    await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toHaveCount(0);
  }
  await page.getByRole("link", { name: /Goals and split are in Coach/ }).click();
  await expect(page).toHaveURL(/\/coach$/);
});

test("with a workout running, six tab items fit at 390px with Resume in front of Coach", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("lift");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("active", "readwrite");
          tx.objectStore("active").put({ key: "active", id: "w1", started_at: new Date().toISOString(), routine_id: null, name: null, exercises: [] });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.goto("/coach");
  await page.waitForLoadState("networkidle");

  const links = nav(page).getByRole("link");
  await expect(links).toHaveText(["Home", "Exercises", "Resume", "Coach", "Progress", "Profile"]);
  for (const box of await Promise.all((await links.all()).map((l) => l.boundingBox()))) {
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  const scrolls = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(scrolls).toBe(false);
});
