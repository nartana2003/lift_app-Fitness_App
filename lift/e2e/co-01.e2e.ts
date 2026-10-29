import { test, expect, type Page } from "@playwright/test";

// CO-01: goals gain priorities, ranked goals, limits and dislikes. Goals saved
// before this existed must keep working in Coach > Goals: the old focus muscles
// show as focus, and toggling focus keeps focusMuscles and priorities in step.

const readGoals = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
        const open = indexedDB.open("lift");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction("meta").objectStore("meta").get("goals");
          get.onsuccess = () => resolve(get.result?.value);
          get.onerror = () => reject(get.error);
        };
      }),
  );

const seedLegacyGoals = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("lift");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("meta", "readwrite");
          tx.objectStore("meta").put({
            key: "goals",
            value: {
              goalType: "build_muscle",
              experience: "intermediate",
              sessionsPerWeek: 4,
              focusMuscles: ["Biceps"],
              targets: {},
              note: "Bigger arms",
            },
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
  );

test("goals saved before priorities existed show their focus and stay consistent when toggled", async ({ page }) => {
  await page.goto("/coach");
  await page.waitForLoadState("networkidle");
  await seedLegacyGoals(page);
  await page.reload();
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /^Goals/ }).click();
  await expect(page.locator("button.chip-on", { hasText: /^Biceps$/ })).toBeVisible();

  // Toggling focus on another muscle writes both views of the same choice.
  await page.locator("button.chip", { hasText: /^Chest$/ }).first().click();
  await expect(page.locator("button.chip-on", { hasText: /^Chest$/ })).toBeVisible();
  await expect.poll(async () => (await readGoals(page))?.focusMuscles).toEqual(["Biceps", "Chest"]);
  const stored = await readGoals(page);
  expect(stored?.priorities).toEqual({ Biceps: "high", Chest: "high" });
  expect(stored?.rankedGoals).toEqual(["Bigger arms"]);
  expect(stored?.note).toBe("Bigger arms");
  expect(stored?.limitations).toEqual([]);

  // Switching a focus muscle off removes its priority, and it survives a reload.
  await page.locator("button.chip-on", { hasText: /^Biceps$/ }).click();
  await expect.poll(async () => (await readGoals(page))?.priorities).toEqual({ Chest: "high" });
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Goals/ }).click();
  await expect(page.locator("button.chip-on", { hasText: /^Chest$/ })).toBeVisible();
  await expect(page.locator("button.chip-on", { hasText: /^Biceps$/ })).toHaveCount(0);
});
