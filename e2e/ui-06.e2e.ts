import { test, expect } from "@playwright/test";

// UI-06: recommended fix on the Stalled lifts card. Seeds a 4-week bench stall
// straight into IndexedDB, then opens /progress. There is no AI key in e2e, so
// the route answers 503: tapping "Get recommended fix" must show a plain note
// while the rule-based advice stays in place.
const EX_ID = "Barbell_Bench_Press_-_Medium_Grip";
const ADVICE = "Try a different rep range, or swap in a close variation for a few weeks.";

test("stalled lifts card keeps its advice when the recommended fix is unavailable", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);

  await page.evaluate(async (exId) => {
    const open = () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("lift");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    const db = await open();
    const tx = db.transaction(["workouts", "workout_exercises", "sets"], "readwrite");
    const day = 864e5;
    // Best at 35 days ago, lower every session since: a 4-week stall.
    const plan: [number, number][] = [[35, 100], [28, 95], [21, 95], [14, 95], [3, 95]];
    plan.forEach(([daysAgo, weight], i) => {
      const at = new Date(Date.now() - daysAgo * day).toISOString();
      tx.objectStore("workouts").put({ id: `e2e-pw${i}`, started_at: at, ended_at: at, notes: null, routine_id: null });
      tx.objectStore("workout_exercises").put({ id: `e2e-pwe${i}`, workout_id: `e2e-pw${i}`, exercise_id: exId, position: 0 });
      for (const n of [1, 2, 3]) {
        tx.objectStore("sets").put({
          id: `e2e-ps${i}-${n}`,
          workout_exercise_id: `e2e-pwe${i}`,
          set_no: n,
          reps: 5,
          weight,
          is_warmup: false,
          rir: null,
          completed_at: at,
        });
      }
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, EX_ID);

  await page.goto("/progress");
  await page.waitForLoadState("networkidle");

  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Stalled lifts" }) });
  await expect(card.getByText("Barbell Bench Press - Medium Grip")).toBeVisible();
  await expect(card.getByText(ADVICE)).toBeVisible();

  await card.getByRole("button", { name: "Get recommended fix" }).click();
  await expect(
    card.getByText(/recommended fix is not available right now|Could not get a recommended fix|recommended fix is available when back online/),
  ).toBeVisible();
  await expect(card.getByLabel("Recommended fix")).toHaveCount(0);
  await expect(card.getByText(ADVICE)).toBeVisible();
  await expect(card.getByRole("button", { name: "Show variations to try" })).toBeVisible();
});
