import { test, expect } from "@playwright/test";

// Every top-level route must render without a server error or an uncaught
// page exception. Auth redirects (to /login) are fine.
const routes = ["/", "/exercises", "/progress", "/profile", "/routines/new", "/workout", "/login"];

for (const route of routes) {
  test(`${route} renders without errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const res = await page.goto(route);
    expect(res?.status() ?? 0).toBeLessThan(500);
    await expect(page.locator("body")).toBeVisible();
    expect(errors).toEqual([]);
  });
}
