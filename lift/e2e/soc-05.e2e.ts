import { test, expect } from "@playwright/test";

// SOC-05: a saved mini workout can be added to today (planned on today when
// nothing is running) and started on its own. Seeds straight into IndexedDB.
test("mini workout: add to today, then start on its own", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);

  await page.evaluate(async () => {
    const open = () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("lift");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    const db = await open();
    const tx = db.transaction(["routines", "routine_exercises"], "readwrite");
    tx.objectStore("routines").put({
      id: "e2e-soc05-m",
      name: "E2E Ab finisher",
      day_label: null,
      source: "social",
      kind: "mini",
      source_url: "https://www.tiktok.com/@coach/video/456",
      platform: "tiktok",
      thumbnail_url: null,
      creator: "@coach",
      notes: null,
      created_at: new Date().toISOString(),
    });
    tx.objectStore("routine_exercises").put({
      id: "e2e-soc05-re1",
      routine_id: "e2e-soc05-m",
      exercise_id: "Crunches",
      position: 0,
      target_sets: 3,
      target_reps: "15",
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  await page.reload();
  await page.waitForLoadState("networkidle");

  const card = page.getByRole("article", { name: "Mini workout: E2E Ab finisher" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Add to today's workout" }).click();
  await expect(card.getByText("Planned for today.")).toBeVisible();

  await card.getByRole("button", { name: "Start" }).click();
  await expect(page).toHaveURL(/\/workout/);
});
