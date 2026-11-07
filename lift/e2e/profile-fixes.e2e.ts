import { test, expect } from "@playwright/test";

// Profile: the date of birth field fits a phone, there is no Coach link row,
// and the Reminders row counts days planned on the This Week strip as on.

test("date of birth fits inside the card at 320px and 390px", async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/profile");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /^Personal information/ }).click();
    const box = await page.locator('input[type="date"]').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test("Profile has no Goals and split link", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("link", { name: /Goals and split are in Coach/ })).toHaveCount(0);
});

test("Reminders row says Off with nothing planned and counts a planned day", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  const header = page.getByRole("button", { name: /^Reminders/ });
  await expect(header).toContainText("Off");

  const tomorrow = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  await page.evaluate(
    (date) =>
      new Promise<void>((res, rej) => {
        const open = indexedDB.open("lift");
        open.onerror = () => rej(open.error);
        open.onsuccess = () => {
          const idb = open.result;
          const tx = idb.transaction("planned_days", "readwrite");
          tx.objectStore("planned_days").put({
            id: "seed-1", date, routine_id: null, status: "planned", workout_id: null,
            skip_reason: null, skip_note: null, moved_to: null, moved_from: null, created_at: new Date().toISOString(),
          });
          tx.oncomplete = () => { idb.close(); res(); };
          tx.onerror = () => rej(tx.error);
        };
      }),
    tomorrow,
  );
  // The row was written straight to IndexedDB, not through Dexie, so the page's
  // live query never sees it. Reload so the page reads it.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(header).toContainText("1 planned day at 18:00");
  await header.click();
  await expect(page.getByText(/Next reminder Tomorrow 18:00/)).toBeVisible();
});
