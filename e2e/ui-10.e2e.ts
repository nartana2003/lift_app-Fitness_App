import { test, expect } from "@playwright/test";

// UI-10: monthly analysis on the Progress Photos tab. Seeds one small JPEG
// photo straight into IndexedDB, then opens /progress?tab=photos. There is no
// AI key in e2e, so the route answers 503: tapping "Analyse month" must show a
// plain note while the gallery stays in place.
test("photos tab shows a plain note when the monthly analysis is unavailable", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);

  await page.evaluate(async () => {
    const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
    const seg = (m: number, p: number[]) => [0xff, m, ...u16(p.length + 2), ...p];
    const bytes = [
      0xff, 0xd8,
      ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
      ...seg(0xdb, [0, ...new Array(64).fill(1)]),
      ...seg(0xc0, [8, ...u16(80), ...u16(60), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
      ...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
      0x12, 0x34, 0xff, 0xd9,
    ];
    const blob = new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = db.transaction(["photos"], "readwrite");
    tx.objectStore("photos").put({ id: "e2e-photo-1", taken_at: new Date().toISOString(), pose: "front", blob });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  await page.goto("/progress?tab=photos");
  await page.waitForLoadState("networkidle");

  const card = page.getByLabel("Monthly analysis");
  await expect(card.getByRole("heading", { name: "Monthly analysis" })).toBeVisible();
  await card.getByRole("button", { name: "Analyse month" }).click();
  await expect(
    card.getByText(/monthly analysis is not available right now|Could not get the monthly analysis|monthly analysis is available when back online/),
  ).toBeVisible();
  await expect(card.getByLabel("Analysis comment")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Add/ })).toBeVisible();
});
