import { test, expect } from "@playwright/test";

// UI-01: "Generate 3-day plan" under My Routines on Home. E2E has no AI key and
// no saved split, so the control must show a short plain message and the
// existing manual routine flow (New routine) must still be there.
test("Generate 3-day plan falls back to a plain message without AI", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await page.waitForLoadState("networkidle"); // let React hydrate before clicking

  await expect(page.getByText("Generate 3-day plan")).toBeVisible();
  await page.getByRole("button", { name: "Generate", exact: true }).click();

  await expect(page.getByRole("status").filter({ hasText: /split in Profile first|build routines by hand/ })).toBeVisible();

  // Manual routine flow unchanged.
  await expect(page.getByRole("heading", { name: "My Routines" })).toBeVisible();
  await expect(page.getByRole("link", { name: "New routine" })).toBeVisible();

  expect(errors).toEqual([]);
});
