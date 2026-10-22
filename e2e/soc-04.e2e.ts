import { test, expect } from "@playwright/test";

// SOC-04: a saved mini workout shows as a card on Home with its platform,
// creator and a link to the original, and the platform filter hides the
// other routines without deleting them. Seeds straight into IndexedDB.
const LINK = "https://www.tiktok.com/@coach/video/123";

test("mini workout card and platform filter", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);

  await page.evaluate(async (link) => {
    const open = () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("lift");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    const db = await open();
    const tx = db.transaction(["routines", "routine_exercises"], "readwrite");
    const base = {
      day_label: null,
      thumbnail_url: null,
      notes: null,
      created_at: new Date().toISOString(),
    };
    tx.objectStore("routines").put({
      ...base,
      id: "e2e-soc04-r",
      name: "E2E Push day",
      source: "manual",
      kind: "routine",
      source_url: null,
      platform: null,
      creator: null,
    });
    tx.objectStore("routines").put({
      ...base,
      id: "e2e-soc04-m",
      name: "E2E Core finisher",
      source: "social",
      kind: "mini",
      source_url: link,
      platform: "tiktok",
      creator: "@coach",
    });
    const rex = (id: string, routineId: string, exerciseId: string) => ({
      id,
      routine_id: routineId,
      exercise_id: exerciseId,
      position: 0,
      target_sets: 3,
      target_reps: "10",
    });
    tx.objectStore("routine_exercises").put(rex("e2e-soc04-re1", "e2e-soc04-r", "Pushups"));
    tx.objectStore("routine_exercises").put(rex("e2e-soc04-re2", "e2e-soc04-m", "Crunches"));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, LINK);

  await page.reload();
  await page.waitForLoadState("networkidle");

  const card = page.getByRole("article", { name: "Mini workout: E2E Core finisher" });
  await expect(card).toBeVisible();
  await expect(card.getByText("TikTok · @coach")).toBeVisible();
  const original = card.getByRole("link", { name: "Open original on TikTok" });
  await expect(original).toHaveAttribute("href", LINK);
  await expect(original).toHaveAttribute("target", "_blank");
  await expect(original).toHaveAttribute("rel", /noopener/);
  await expect(page.getByText("E2E Push day")).toBeVisible();

  const platforms = page.getByRole("group", { name: "Filter by platform" });
  await platforms.getByRole("button", { name: "TikTok" }).click();
  await expect(platforms.getByRole("button", { name: "TikTok" })).toHaveAttribute("aria-pressed", "true");
  await expect(card).toBeVisible();
  await expect(page.getByText("E2E Push day")).toHaveCount(0);

  await platforms.getByRole("button", { name: "All sources" }).click();
  await expect(page.getByText("E2E Push day")).toBeVisible();
  await expect(page.getByRole("link", { name: "New routine" })).toBeVisible();
});
