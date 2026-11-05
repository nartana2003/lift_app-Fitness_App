import { test, expect } from "@playwright/test";

// Issue #3: a changed weekly set target persists, including quick repeated taps,
// and survives a reload. Reset returns it to the suggested number.

test("weekly set targets count every tap and survive a reload", async ({ page }) => {
  await page.goto("/coach");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /^Goals/ }).click();
  await page.getByRole("button", { name: /Weekly set targets/ }).click();

  const row = page.getByRole("button", { name: "More Chest sets" }).locator("xpath=ancestor::li");
  const value = row.locator("span").nth(1);
  const start = Number(await value.innerText());

  const more = page.getByRole("button", { name: "More Chest sets" });
  await more.click({ clickCount: 3, delay: 0 });
  await expect(value).toHaveText(String(start + 3));

  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Goals/ }).click();
  await page.getByRole("button", { name: /Weekly set targets/ }).click();
  await expect(value).toHaveText(String(start + 3));

  await page.getByRole("button", { name: "Fewer Chest sets" }).click();
  await expect(value).toHaveText(String(start + 2));

  await row.getByRole("button", { name: "reset" }).click();
  await expect(value).toHaveText(String(start));
});
