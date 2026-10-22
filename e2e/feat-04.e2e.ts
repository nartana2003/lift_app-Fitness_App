import { test, expect, type Page } from "@playwright/test";

// FEAT-04: progress photo prompt on the workout Finish screen. Seeds an
// in-progress workout with one completed set straight into IndexedDB, then
// finishes it. The Finish screen offers front, side and back photos; Skip
// goes on to the saved workout. No Supabase or AI key is needed.
const EX_ID = "Barbell_Bench_Press_-_Medium_Grip";

async function seedActive(page: Page, id: string, routineId: string | null) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);

  await page.evaluate(
    async ({ exId, id, routineId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("lift");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const tx = db.transaction(["active"], "readwrite");
      const row: Record<string, unknown> = {
        key: "active",
        id,
        started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
        name: null,
        exercises: [{ id: "e2e-card", exercise_id: exId, sets: [{ id: "s1", reps: 8, weight: 60, is_warmup: false, rir: null, done: true }] }],
      };
      if (routineId) row.routine_id = routineId;
      tx.objectStore("active").put(row);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { exId: EX_ID, id, routineId },
  );

  await page.goto("/workout");
  await page.waitForLoadState("networkidle");
}

test("finish offers front, side and back photos and Skip opens the workout", async ({ page }) => {
  // From a routine, so no "save as routine?" sheet follows the photos.
  await seedActive(page, "e2e-feat04", "e2e-routine");

  await page.getByRole("button", { name: "Finish" }).click();
  await page.getByRole("button", { name: "Save workout" }).click();

  await expect(page.getByRole("heading", { name: "Progress photos" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Take front photo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Take side photo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Take back photo" })).toBeVisible();

  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/history\/e2e-feat04$/);
});

test("a workout without a routine shows photos, then Save as routine, then the workout", async ({ page }) => {
  await seedActive(page, "e2e-feat04-free", null);

  await page.getByRole("button", { name: "Finish" }).click();
  await page.getByRole("button", { name: "Save workout" }).click();

  await expect(page.getByRole("heading", { name: "Progress photos" })).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();

  await expect(page.getByRole("heading", { name: "Save as routine" })).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page).toHaveURL(/\/history\/e2e-feat04-free$/);
});
