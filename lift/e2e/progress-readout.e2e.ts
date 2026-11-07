import { test, expect } from "@playwright/test";

// Issue #6: the Progress chart shows the volume, workouts or duration total above
// the bars without tapping a bar, and a hovered bar shows its own week.
const BENCH = "Barbell_Bench_Press_-_Medium_Grip";

test("Progress chart shows its totals above the bars", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);

  await page.evaluate(async (bench) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const start = new Date(Date.now() - 2 * 3600e3);
    const tx = db.transaction(["workouts", "workout_exercises", "sets"], "readwrite");
    tx.objectStore("workouts").put({
      id: "e2e-readout-w",
      started_at: start.toISOString(),
      ended_at: new Date(start.getTime() + 40 * 60e3).toISOString(),
      notes: null,
      routine_id: null,
    });
    tx.objectStore("workout_exercises").put({ id: "e2e-readout-we", workout_id: "e2e-readout-w", exercise_id: bench, position: 0 });
    for (let i = 0; i < 3; i++)
      tx.objectStore("sets").put({
        id: `e2e-readout-s${i}`,
        workout_exercise_id: "e2e-readout-we",
        set_no: i + 1,
        reps: 8,
        weight: 50,
        is_warmup: false,
        rir: null,
        completed_at: start.toISOString(),
      });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, BENCH);

  await page.goto("/progress");
  await page.waitForLoadState("networkidle");

  const readout = page.getByTestId("chart-readout");
  await expect(readout).toContainText("Volume · 3 Months");
  await expect(readout).toContainText("1.2k");

  await page.getByRole("button", { name: "Duration", exact: true }).click();
  await expect(readout).toContainText("Duration · 3 Months");
  await expect(readout).toContainText("40m");

  await page.getByRole("button", { name: "Workouts", exact: true }).click();
  await expect(readout).toContainText("Workouts · 3 Months");
  await expect(readout).toContainText("1");

  await page.locator("select").first().selectOption("1m");
  await expect(readout).toContainText("Workouts · 1 Month");

  // Hover the last bar (this week): the readout switches to that week.
  const chart = page.locator(".recharts-wrapper").first();
  const box = await chart.boundingBox();
  await page.mouse.move(box!.x + box!.width - 30, box!.y + box!.height / 2);
  await expect(readout).toContainText(/\d+ \w{3} - \d+ \w{3}/);
  await page.mouse.move(box!.x - 20, box!.y - 20);
  await expect(readout).toContainText("Workouts · 1 Month");
});
