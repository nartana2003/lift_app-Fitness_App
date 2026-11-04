import { test, expect } from "@playwright/test";

// UI-01: the "Generate 3-day plan" card was removed from My Routines on Home.
// The existing manual routine flow (New routine) must still be there; since
// NAV-01 My Routines lives on Exercises > Routines.
test("Home no longer shows the Generate plan card", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await page.waitForLoadState("networkidle"); // let React hydrate before asserting

  await expect(page.getByText(/Generate \d-day plan/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tell the coach", exact: true })).toHaveCount(0);

  await page.goto("/exercises?view=routines");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Routines", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "New routine" })).toBeVisible();
  await expect(page.getByText(/Generate \d-day plan/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tell the coach", exact: true })).toHaveCount(0);

  expect(errors).toEqual([]);
});
