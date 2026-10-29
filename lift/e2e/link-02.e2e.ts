import { test, expect } from "@playwright/test";

// LINK-02: build a split day in Coach > My split, attach an existing
// (unassigned) routine to it, then see that routine grouped under the day on
// Home. The routine is seeded straight into IndexedDB. No AI involved.
test("attach a routine to a split day and see it grouped on Home", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);

  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = db.transaction(["routines", "routine_exercises"], "readwrite");
    tx.objectStore("routines").put({
      id: "e2e-link02-r",
      name: "E2E Upper",
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
    tx.objectStore("routine_exercises").put({
      id: "e2e-link02-re",
      routine_id: "e2e-link02-r",
      exercise_id: "Pushups",
      position: 0,
      target_sets: 3,
      target_reps: "10",
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  await page.goto("/coach");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^My split/ }).click();
  await page.getByRole("button", { name: "Build my own" }).click();

  const day = page.getByRole("group", { name: "Routines for Day 1" });
  await expect(day.getByText("No routine: pick exercises from your pool on the day.")).toBeVisible();
  await day.getByRole("button", { name: "+ Add routine" }).click();
  await expect(day.getByRole("link", { name: "New routine for this day" })).toBeVisible();
  await day.getByLabel("Attach a routine").selectOption({ label: "E2E Upper" });
  await expect(day.getByText("E2E Upper")).toBeVisible();
  await expect(day.getByRole("button", { name: "Start" })).toBeVisible();

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const group = page.getByRole("group", { name: "Day 1", exact: true }).filter({ hasText: "E2E Upper" });
  await expect(group.getByRole("heading", { name: "Day 1" })).toBeVisible();
  await expect(group.getByText("E2E Upper")).toBeVisible();

  expect(errors).toEqual([]);
});
