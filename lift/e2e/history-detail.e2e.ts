import { test, expect } from "@playwright/test";

// History detail: no weekday title, date and time of start, then Duration,
// Volume and Records, and each exercise shows its round picture. All local.

test("history detail shows date, Duration, Volume, Records and exercise pictures", async ({ page }) => {
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
    const start = new Date(Date.now() - 3 * 864e5);
    const tx = db.transaction(["workouts", "workout_exercises", "sets"], "readwrite");
    tx.objectStore("workouts").put({
      id: "e2e-hd",
      started_at: start.toISOString(),
      ended_at: new Date(start.getTime() + 40 * 60e3).toISOString(),
      notes: null,
      routine_id: null,
    });
    tx.objectStore("workout_exercises").put({ id: "e2e-hd-we", workout_id: "e2e-hd", exercise_id: "3_4_Sit-Up", position: 0 });
    tx.objectStore("sets").put({
      id: "e2e-hd-s0",
      workout_exercise_id: "e2e-hd-we",
      set_no: 1,
      reps: 5,
      weight: 10,
      is_warmup: false,
      rir: 2,
      completed_at: start.toISOString(),
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  await page.goto("/history/e2e-hd");
  await expect(page.getByRole("heading", { name: "Workout", exact: true })).toBeVisible();
  const weekday = new Date(Date.now() - 3 * 864e5).toLocaleDateString("en-US", { weekday: "long" });
  await expect(page.getByRole("heading", { name: weekday })).toHaveCount(0);
  await expect(page.getByText("Duration")).toBeVisible();
  await expect(page.getByText("Volume")).toBeVisible();
  await expect(page.getByText("Records")).toBeVisible();
  await expect(page.getByText("Sets", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("img", { name: "3/4 Sit-Up" })).toBeVisible();
  // The options button is three dots stacked vertically.
  const dots = page.getByRole("button", { name: "More options" }).locator("circle");
  await expect(dots).toHaveCount(3);
  const ys = await dots.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().y));
  expect(ys[0]).toBeLessThan(ys[1]);
  expect(ys[1]).toBeLessThan(ys[2]);
  // A logged RIR is not shown on the detail page.
  await expect(page.getByText(/RIR/)).toHaveCount(0);
  // Lyfta-style summary: a picture grid with "N x name" captions.
  const grid = page.getByRole("list", { name: "Exercises done" });
  await expect(grid.getByText("1 x 3/4 Sit-Up")).toBeVisible();
});
