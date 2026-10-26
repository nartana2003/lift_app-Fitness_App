import { test, expect } from "@playwright/test";

// UI-02: "Suggest weekly targets" on Profile > Goals. E2E has no AI key, so the
// route answers 503 (or fails); the card must show a short plain message and
// the existing rule-based "Weekly set targets" editor must still be there.
test("Suggest weekly targets falls back to a plain message without AI", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/profile");
  await page.waitForLoadState("networkidle"); // let React hydrate before clicking
  await page.getByRole("button", { name: /^Goals/ }).click();

  await expect(page.getByText("Suggest weekly targets")).toBeVisible();
  await page.getByRole("button", { name: "Suggest", exact: true }).click();

  await expect(page.getByRole("status").filter({ hasText: "Your current targets still apply." })).toBeVisible();

  // Rule-based editor unchanged and still usable.
  const editor = page.getByRole("button", { name: /Weekly set targets/ });
  await expect(editor).toBeVisible();
  await editor.click();
  await expect(page.getByRole("button", { name: "More Chest sets" })).toBeVisible();

  expect(errors).toEqual([]);
});
