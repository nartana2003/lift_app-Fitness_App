import { test, expect } from "@playwright/test";

// Issue #4: Start Workout on Home offers the user's routines. With no routine it
// still starts an empty workout straight away.
const BENCH = "Barbell_Bench_Press_-_Medium_Grip";

async function openDb(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);
}

test("with no routines Start Workout opens an empty workout", async ({ page }) => {
  await openDb(page);
  await page.getByRole("button", { name: "Start Workout" }).click();
  await expect(page).toHaveURL(/\/workout$/);
  await expect(page.getByText("Complete set")).toHaveCount(0);
});

test("with routines Start Workout lists them and starts the chosen one", async ({ page }) => {
  await openDb(page);
  await page.evaluate(async (bench) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = db.transaction(["routines", "routine_exercises"], "readwrite");
    tx.objectStore("routines").put({
      id: "e2e-r4",
      name: "E2E Push day",
      day_label: null,
      source: "manual",
      kind: "routine",
      source_url: null,
      platform: null,
      thumbnail_url: null,
      creator: null,
      notes: null,
      created_at: new Date().toISOString(),
    });
    tx.objectStore("routine_exercises").put({ id: "e2e-r4-e0", routine_id: "e2e-r4", exercise_id: bench, position: 0, target_sets: 3, target_reps: "8-12" });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, BENCH);

  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Start Workout" }).click();
  const list = page.getByRole("group", { name: "Start from" });
  await expect(list.getByRole("button", { name: "Empty workout" })).toBeVisible();
  await list.getByRole("button", { name: "E2E Push day" }).click();

  await expect(page).toHaveURL(/\/workout$/);
  await expect(page.getByRole("button", { name: "Complete set" })).toHaveCount(3);
});
