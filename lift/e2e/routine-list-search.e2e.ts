import { test, expect, type Page } from "@playwright/test";

// Routines view on the Exercises tab: tiles stack vertically, a search box filters by
// name, and the muscle filter shows muscle visuals like the Exercises view.

const seed = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("lift");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(["routines", "routine_exercises"], "readwrite");
          const base = { day_label: null, source: "manual", kind: "routine", source_url: null, platform: null, thumbnail_url: null, creator: null, notes: null };
          tx.objectStore("routines").put({ ...base, id: "rt1", name: "Pull Day", created_at: "2026-01-01T00:00:00.000Z" });
          tx.objectStore("routines").put({ ...base, id: "rt2", name: "Leg Day", created_at: "2026-01-02T00:00:00.000Z" });
          tx.objectStore("routine_exercises").put({ id: "re1", routine_id: "rt1", exercise_id: "Barbell_Curl", position: 0, target_sets: 3, target_reps: "10" });
          tx.objectStore("routine_exercises").put({ id: "re2", routine_id: "rt2", exercise_id: "Triceps_Pushdown", position: 0, target_sets: 3, target_reps: "10" });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
  );

test("routines stack vertically and can be searched by name", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await seed(page);
  await page.goto("/exercises?view=routines");
  await page.waitForLoadState("networkidle");

  const pull = page.getByText("Pull Day", { exact: true });
  const legs = page.getByText("Leg Day", { exact: true });
  await expect(pull).toBeVisible();
  await expect(legs).toBeVisible();
  const a = (await pull.boundingBox())!;
  const b = (await legs.boundingBox())!;
  expect(b.y).toBeGreaterThan(a.y + 40);
  expect(Math.abs(a.x - b.x)).toBeLessThan(5);

  const box = page.getByRole("searchbox", { name: "Search routines" });
  await box.fill("leg");
  await expect(legs).toBeVisible();
  await expect(pull).toHaveCount(0);
  await box.fill("nothing");
  await expect(page.getByText("No routines match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(pull).toBeVisible();
  await expect(legs).toBeVisible();

  // Muscle visuals, not plain text chips.
  const group = page.getByRole("group", { name: "Filter by muscle" });
  await expect(group.locator("svg").first()).toBeVisible();
  await group.getByRole("button").first().click();
  await expect(group.getByRole("button", { pressed: true })).toHaveCount(1);
});
