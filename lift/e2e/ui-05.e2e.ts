import { test, expect } from "@playwright/test";

// UI-05: overload suggestion in the live workout. Seeds one finished bench
// session and an in-progress workout straight into IndexedDB, then opens
// /workout. There is no AI key in e2e, so the route answers 503: the
// rule-based "Today" suggestion must show and work, with no AI line.
const EX_ID = "Barbell_Bench_Press_-_Medium_Grip";

test("live workout shows the rule-based suggestion and no AI line when AI is unavailable", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  // Home reads the local store, so Dexie creates the "lift" database with its tables.
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
    const tx = db.transaction(["workouts", "workout_exercises", "sets", "active"], "readwrite");
    const at = "2026-10-10T09:00:00.000Z";
    tx.objectStore("workouts").put({ id: "e2e-w1", started_at: at, ended_at: at, notes: null, routine_id: null });
    tx.objectStore("workout_exercises").put({ id: "e2e-we1", workout_id: "e2e-w1", exercise_id: exId, position: 0 });
    for (const n of [1, 2, 3]) {
      tx.objectStore("sets").put({
        id: `e2e-s${n}`,
        workout_exercise_id: "e2e-we1",
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
      id: "e2e-live",
      started_at: new Date().toISOString(),
      routine_id: null,
      name: null,
      exercises: [{ id: "e2e-card", exercise_id: exId, sets: [blank("a"), blank("b"), blank("c")], target_reps: "8-12" }],
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, EX_ID);

  const answered = page.waitForResponse((r) => r.url().includes("/api/ai/overload-suggestion"));
  await page.goto("/workout");

  const today = page.getByRole("button", { name: /Today: 3×8 @ 62\.5kg/ });
  await expect(today).toBeVisible();
  expect((await answered).status()).toBe(503);
  await expect(page.getByRole("button", { name: /AI refined/ })).toHaveCount(0);

  // Rule-based tap-to-use still fills the sets.
  await today.click();
  await expect(page.getByRole("textbox").first()).toHaveValue("62.5");
});
