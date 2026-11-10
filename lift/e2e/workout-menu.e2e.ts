import { test, expect } from "@playwright/test";

// Workout exercise card: the three-dot menu holds Rest, Swap exercise and
// Remove exercise. There are no Move up / Move down buttons.

test("exercise options menu has Rest, Swap and Remove but no Move up or Move down", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("lift");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const idb = open.result;
          const tx = idb.transaction("active", "readwrite");
          tx.objectStore("active").put({
            key: "active", id: "w1", started_at: new Date().toISOString(), routine_id: null, name: null,
            exercises: [{ id: "c1", exercise_id: "bench-press", sets: [{ id: "s1", reps: "", weight: "", is_warmup: false, rir: null, done: false }], target_reps: "8-12" }],
          });
          tx.oncomplete = () => { idb.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.goto("/workout");
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("button", { name: /Swap exercise/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Options" }).first().click();
  await expect(page.getByRole("combobox", { name: "Rest timer" })).toBeAttached();
  await expect(page.getByRole("button", { name: /Swap exercise/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove exercise" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Move up/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Move down/ })).toHaveCount(0);
});

test("the options menu floats over the card without moving the sets, and closes on Escape or an outside tap", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("lift");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const idb = open.result;
          const tx = idb.transaction("active", "readwrite");
          tx.objectStore("active").put({
            key: "active", id: "w1", started_at: new Date().toISOString(), routine_id: null, name: null,
            exercises: [{ id: "c1", exercise_id: "bench-press", sets: [{ id: "s1", reps: "", weight: "", is_warmup: false, rir: null, done: false }], target_reps: "8-12" }],
          });
          tx.oncomplete = () => { idb.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.goto("/workout");
  await page.waitForLoadState("networkidle");

  const firstSet = page.getByRole("button", { name: "Complete set" }).first();
  const before = (await firstSet.boundingBox())!;
  await page.getByRole("button", { name: "Options" }).first().click();
  const menu = page.getByRole("group", { name: "Exercise options" });
  await expect(menu).toBeVisible();
  const after = (await firstSet.boundingBox())!;
  expect(after.y).toBeCloseTo(before.y, 0);
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.getByRole("button", { name: "Options" }).first().click();
  await expect(menu).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(menu).toHaveCount(0);
});
