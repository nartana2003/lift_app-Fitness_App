import { test, expect } from "@playwright/test";

// Exercise detail: no repeated last time, an honest trend message, records once, a
// collapsed History, and the TikTok button.
const BENCH = "Barbell_Bench_Press_-_Medium_Grip";

test("exercise detail shows progress, records and history", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift"))).toBe(true);
  await page.evaluate(async (bench) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const at = "2026-11-10T09:00:00.000Z";
    const tx = db.transaction(["workouts", "workout_exercises", "sets"], "readwrite");
    tx.objectStore("workouts").put({ id: "e2e-w", started_at: at, ended_at: at, notes: null, routine_id: null });
    tx.objectStore("workout_exercises").put({ id: "e2e-we", workout_id: "e2e-w", exercise_id: bench, position: 0 });
    [8, 9, 10].forEach((reps, i) =>
      tx.objectStore("sets").put({ id: `e2e-s${i}`, workout_exercise_id: "e2e-we", set_no: i + 1, reps, weight: 23, is_warmup: false, rir: null, completed_at: at }),
    );
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, BENCH);

  await page.goto(`/exercises/${BENCH}`);
  await page.waitForLoadState("networkidle");

  // Last time is shown in the workout, not repeated here.
  await expect(page.getByText("Last time")).toHaveCount(0);

  // One session is not a trend.
  await expect(page.getByText("Log one more session to see your trend.")).toBeVisible();

  // Records appear once, as four cards.
  await expect(page.getByRole("heading", { name: "Records" })).toBeVisible();
  for (const label of ["Heaviest", "Most reps", "Best est. 1RM", "Best volume"]) await expect(page.getByText(label, { exact: true })).toHaveCount(1);

  // History is collapsed and says 1 session.
  await expect(page.getByText("1 session", { exact: true })).toBeVisible();
  await expect(page.locator("details").first()).not.toHaveAttribute("open", "");

  // The Watch on TikTok button is still there, and there is no Add to workout button.
  await expect(page.getByRole("link", { name: "Watch on TikTok" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Add to workout|In your workout/ })).toHaveCount(0);
});
