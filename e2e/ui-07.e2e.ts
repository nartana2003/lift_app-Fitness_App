import { test, expect } from "@playwright/test";

// UI-07: swap sheet in the live workout. Seeds an in-progress workout straight
// into IndexedDB, then opens /workout and the swap sheet. There is no AI key
// in e2e, so the route answers 503: the rule-based list must show and work,
// with no "Coach picks" section.
const EX_ID = "Barbell_Bench_Press_-_Medium_Grip";
const EX_NAME = "Barbell Bench Press - Medium Grip";

test("swap sheet shows the rule-based list and no Coach picks when AI is unavailable", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);

  await page.evaluate(async (exId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = db.transaction(["active"], "readwrite");
    const blank = (id: string) => ({ id, reps: "", weight: "", is_warmup: false, rir: null, done: false });
    tx.objectStore("active").put({
      key: "active",
      id: "e2e-live",
      started_at: new Date().toISOString(),
      routine_id: null,
      name: null,
      exercises: [{ id: "e2e-card", exercise_id: exId, sets: [blank("a"), blank("b")], target_reps: "8-12" }],
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, EX_ID);

  await page.goto("/workout");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: EX_NAME, exact: true })).toBeVisible();

  const answered = page.waitForResponse((r) => r.url().includes("/api/ai/swap-exercise"));
  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("button", { name: /Swap exercise/ }).click();

  await expect(page.getByRole("heading", { name: `Swap ${EX_NAME}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Machine busy" })).toBeVisible();
  expect((await answered).status()).toBe(503);
  await expect(page.getByText("Coach picks")).toHaveCount(0);

  // The rule-based list still swaps the exercise.
  const list = page.getByRole("list").last();
  await list.getByRole("button").first().click();
  await expect(page.getByRole("heading", { name: `Swap ${EX_NAME}` })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: EX_NAME, exact: true })).toHaveCount(0);
});
