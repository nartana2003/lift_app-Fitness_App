import { test, expect } from "@playwright/test";

// The Preferences "Workout suggestions" switch hides and shows the overload
// suggestion on the live workout card. Seeds one finished bench session
// (3x12 @ 60kg) and an in-progress workout, then flips the switch on /profile.
const EX_ID = "Barbell_Bench_Press_-_Medium_Grip";

test("Workout suggestions preference turns the live suggestion off and on", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);

  await page.evaluate(async (exId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = db.transaction(["workouts", "workout_exercises", "sets", "active"], "readwrite");
    const at = "2026-10-10T09:00:00.000Z";
    tx.objectStore("workouts").put({ id: "e2e-sp-w1", started_at: at, ended_at: at, notes: null, routine_id: null });
    tx.objectStore("workout_exercises").put({ id: "e2e-sp-we1", workout_id: "e2e-sp-w1", exercise_id: exId, position: 0 });
    for (const n of [1, 2, 3]) {
      tx.objectStore("sets").put({
        id: `e2e-sp-s${n}`,
        workout_exercise_id: "e2e-sp-we1",
        set_no: n,
        reps: 12,
        weight: 60,
        is_warmup: false,
        rir: null,
        completed_at: at,
      });
    }
    const blank = (id: string) => ({ id, reps: "", weight: "", is_warmup: false, rir: null, done: false });
    tx.objectStore("active").put({
      key: "active",
      id: "e2e-sp-live",
      started_at: new Date().toISOString(),
      routine_id: null,
      name: null,
      exercises: [{ id: "e2e-sp-card", exercise_id: exId, sets: [blank("a"), blank("b"), blank("c")], target_reps: "8-12" }],
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, EX_ID);

  const suggestion = () => page.getByRole("button", { name: /Use suggestion: 3×8 @ 62\.5kg/ });

  // On by default.
  await page.goto("/workout");
  await expect(suggestion()).toBeVisible();

  // Turn it off in Preferences.
  await page.goto("/profile");
  await page.getByRole("button", { name: /Preferences/ }).click();
  const group = page.getByRole("radiogroup", { name: "Workout suggestions" });
  await expect(group.getByRole("radio", { name: "On" })).toHaveAttribute("aria-checked", "true");
  await group.getByRole("radio", { name: "Off" }).click();
  await expect(group.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");

  // Workout shows last time but no suggestion.
  await page.goto("/workout");
  await expect(page.getByText("Last time: 3×12 @ 60kg")).toBeVisible();
  await expect(suggestion()).toHaveCount(0);

  // Back on.
  await page.goto("/profile");
  await page.getByRole("button", { name: /Preferences/ }).click();
  await page.getByRole("radiogroup", { name: "Workout suggestions" }).getByRole("radio", { name: "On" }).click();
  await page.goto("/workout");
  await expect(suggestion()).toBeVisible();
});
