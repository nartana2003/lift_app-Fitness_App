import { test, expect } from "@playwright/test";

// UI-08: quick-log box in the live workout. Seeds an in-progress workout into
// IndexedDB, then opens /workout. There is no AI key in e2e, so parse-log
// answers 503: a plain message shows and manual logging stays as it was.
test("quick log shows a plain message when AI is unavailable and manual logging still works", async ({ page }) => {
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
    const tx = db.transaction(["active"], "readwrite");
    tx.objectStore("active").put({
      key: "active",
      id: "e2e-ui08",
      started_at: new Date().toISOString(),
      routine_id: null,
      name: null,
      exercises: [],
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  await page.goto("/workout");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Quick log" }).click();
  await page.getByLabel("Quick log text").fill("bench 3x8 at 60");

  const answered = page.waitForResponse((r) => r.url().includes("/api/ai/parse-log"));
  await page.getByRole("button", { name: "Preview" }).click();
  expect((await answered).status()).toBe(503);

  await expect(page.getByText("Quick log is not available right now. You can still add exercises by hand.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Parsed sets" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ Add exercise" })).toBeVisible();
});
