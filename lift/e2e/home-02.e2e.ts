import { test, expect } from "@playwright/test";

// HOME-02: Home has no greeting, and each history entry is a card with
// Duration, Volume, Records and a thumbnail grid of the exercises. Seeds an
// earlier finished workout plus a live one into IndexedDB, finishes the live
// one through the UI, then checks its card. All local; no Supabase or AI key.
const BENCH = "Barbell_Bench_Press_-_Medium_Grip";

test("Home shows no greeting and the logged workout as a card with records and thumbnails", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: "Start Workout" })).toBeVisible();
  await expect(page.getByText(/Good (morning|afternoon|evening)/)).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);

  await page.evaluate(async (bench) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const now = Date.now();
    const earlier = new Date(now - 3 * 864e5).toISOString();
    const tx = db.transaction(["workouts", "workout_exercises", "sets", "active"], "readwrite");
    tx.objectStore("workouts").put({
      id: "e2e-home02-a",
      started_at: earlier,
      ended_at: new Date(now - 3 * 864e5 + 40 * 60e3).toISOString(),
      notes: "E2E Earlier",
      routine_id: null,
    });
    tx.objectStore("workout_exercises").put({ id: "e2e-home02-a-we", workout_id: "e2e-home02-a", exercise_id: bench, position: 0 });
    for (let i = 0; i < 3; i++)
      tx.objectStore("sets").put({
        id: `e2e-home02-a-s${i}`,
        workout_exercise_id: "e2e-home02-a-we",
        set_no: i + 1,
        reps: 8,
        weight: 50,
        is_warmup: false,
        rir: null,
        completed_at: earlier,
      });
    const set = (id: string, weight: number) => ({ id, reps: 8, weight, is_warmup: false, rir: null, done: true });
    // A routine id skips the "save as routine?" sheet after finishing.
    tx.objectStore("active").put({
      key: "active",
      id: "e2e-home02-b",
      started_at: new Date(now - 30 * 60e3).toISOString(),
      routine_id: "e2e-home02-routine",
      name: "E2E Push",
      exercises: [
        { id: "e2e-home02-b-we0", exercise_id: bench, sets: [set("b0", 60), set("b1", 60), set("b2", 60)] },
        { id: "e2e-home02-b-we1", exercise_id: "e2e-letter-move", sets: [set("b3", 20), set("b4", 20)] },
      ],
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, BENCH);

  // Log it: finish the live workout through the UI.
  await page.goto("/workout");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page.getByRole("button", { name: "Save workout" }).click();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page).toHaveURL(/\/history\/e2e-home02-b/);

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/Good (morning|afternoon|evening)/)).toHaveCount(0);

  const card = page.getByRole("link").filter({ hasText: "E2E Push" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Duration")).toBeVisible();
  await expect(card.getByText("30m")).toBeVisible();
  await expect(card.getByText("Volume")).toBeVisible();
  await expect(card.getByText("1,760kg")).toBeVisible();
  await expect(card.getByText("Records")).toBeVisible();
  // 60x8 after 50x8: heaviest weight and best e1RM on set 1, best session volume on set 3.
  await expect(card.getByText("Records").locator("xpath=following-sibling::p[1]")).toHaveText("3");
  await expect(card.getByText("3 x Barbell Bench Press - Medium Grip")).toBeVisible();
  await expect(card.locator('img[alt="Barbell Bench Press - Medium Grip"]')).toHaveAttribute("src", /free-exercise-db/);
  await expect(card.getByText("2 x e2e-letter-move")).toBeVisible();
  await expect(card.getByText("E", { exact: true })).toBeVisible();

  const earlier = page.getByRole("link").filter({ hasText: "E2E Earlier" });
  await expect(earlier.getByText("Records").locator("xpath=following-sibling::p[1]")).toHaveText("0");

  await card.click();
  await expect(page).toHaveURL(/\/history\/e2e-home02-b/);
});
