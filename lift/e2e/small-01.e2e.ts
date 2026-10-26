import { test, expect } from "@playwright/test";

// SMALL-01: a plateau "Start lighter week" record makes the live workout's
// Today suggestion lighter. Seeds last session (3x12 @ 100kg bench), a running
// lighter week at 60kg and an in-progress workout into IndexedDB, then opens
// /workout. No AI key in e2e; the lighter suggestion is rule-based.
const BENCH = "Barbell_Bench_Press_-_Medium_Grip";

test("a running lighter week shows a lighter Today suggestion that fills the sets on tap", async ({ page }) => {
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
    const tx = db.transaction(["active", "workouts", "workout_exercises", "sets", "meta"], "readwrite");
    const day = 864e5;
    tx.objectStore("workouts").put({
      id: "e2e-small01-old",
      started_at: new Date(Date.now() - 3 * day).toISOString(),
      ended_at: new Date(Date.now() - 3 * day + 3600e3).toISOString(),
      notes: null,
      routine_id: null,
    });
    tx.objectStore("workout_exercises").put({ id: "e2e-small01-we", workout_id: "e2e-small01-old", exercise_id: bench, position: 0 });
    for (let n = 1; n <= 3; n++) {
      tx.objectStore("sets").put({
        id: `e2e-small01-s${n}`,
        workout_exercise_id: "e2e-small01-we",
        set_no: n,
        reps: 12,
        weight: 100,
        is_warmup: false,
        rir: null,
        completed_at: new Date(Date.now() - 3 * day + 3600e3).toISOString(),
      });
    }
    tx.objectStore("meta").put({
      key: "plateau_fix_applied",
      value: {
        [bench]: {
          kind: "deload",
          headline: "Take a lighter week",
          applied_at: new Date(Date.now() - day).toISOString(),
          until: new Date(Date.now() + 6 * day).toISOString(),
          deload_percent: 60,
          deload_weight: 60,
        },
      },
    });
    const blank = (id: string) => ({ id, reps: "", weight: "", is_warmup: false, rir: null, done: false });
    tx.objectStore("active").put({
      key: "active",
      id: "e2e-small01",
      started_at: new Date().toISOString(),
      routine_id: null,
      name: null,
      exercises: [{ id: "e2e-small01-card", exercise_id: bench, sets: [blank("a"), blank("b"), blank("c")], target_reps: "8-12" }],
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, BENCH);

  await page.goto("/workout");
  await page.waitForLoadState("networkidle");

  await expect(page.getByText("Lighter week: about 60% of your usual weight. Keep every set easy.")).toBeVisible();
  const today = page.getByRole("button", { name: /Today: 3×8 @ 60kg/ });
  await expect(today).toBeVisible();
  await today.click();
  // The first set's weight box now holds the lighter weight.
  await expect(page.getByRole("textbox").first()).toHaveValue("60");

  // Manual logging and quick log are still there.
  await expect(page.getByRole("button", { name: "+ Add exercise" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Quick log" })).toBeVisible();
});
