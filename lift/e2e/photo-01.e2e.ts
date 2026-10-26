import { test, expect } from "@playwright/test";

// PHOTO-01: slider overlay compare on the Progress Photos tab. Seeds two small
// JPEG photos (front and side) straight into IndexedDB, picks both, opens the
// compare (side by side by default), switches to Slider and moves the labelled
// range input with the keyboard.
test("compare two photos with the slider overlay", async ({ page }) => {
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
    const blob = () => new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = db.transaction(["photos"], "readwrite");
    const store = tx.objectStore("photos");
    store.put({ id: "e2e-photo-early", taken_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), pose: "front", blob: blob() });
    store.put({ id: "e2e-photo-late", taken_at: new Date().toISOString(), pose: "side", blob: blob() });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  await page.goto("/progress?tab=photos");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Compare two photos" }).click();
  await page.getByRole("button", { name: /· front/ }).click();
  await page.getByRole("button", { name: /· side/ }).click();
  await page.getByRole("button", { name: "Compare (2/2)" }).click();

  await expect(page.getByRole("heading", { name: "Compare" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Reveal later photo" })).toHaveCount(0);

  await page.getByRole("button", { name: "Slider" }).click();
  const range = page.getByRole("slider", { name: "Reveal later photo" });
  await expect(range).toBeVisible();
  await expect(range).toHaveValue("50");

  await range.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(range).toHaveValue("52");

  await range.fill("80");
  await expect(range).toHaveValue("80");

  await page.getByRole("button", { name: "Side by side" }).click();
  await expect(page.getByRole("slider", { name: "Reveal later photo" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "Compare two photos" })).toBeVisible();
});
