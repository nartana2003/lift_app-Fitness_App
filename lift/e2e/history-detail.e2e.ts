import { test, expect } from "@playwright/test";

// History detail: no weekday title, date and time of start, then Duration,
// Volume and Records, a body map, and each exercise as a card with its picture, a SET / WEIGHT & REPS
// table and a badge for each record a set earned. All local.

test("history detail shows the summary, body map, set table and record badges", async ({ page }) => {
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
    const before = new Date(Date.now() - 9 * 864e5);
    const tx = db.transaction(["workouts", "workout_exercises", "sets"], "readwrite");
    // An earlier session of the same exercise, so the later one can beat it.
    tx.objectStore("workouts").put({ id: "e2e-hd-old", started_at: before.toISOString(), ended_at: new Date(before.getTime() + 40 * 60e3).toISOString(), notes: null, routine_id: null });
    tx.objectStore("workout_exercises").put({ id: "e2e-hd-old-we", workout_id: "e2e-hd-old", exercise_id: "3_4_Sit-Up", position: 0 });
    tx.objectStore("sets").put({ id: "e2e-hd-old-s0", workout_exercise_id: "e2e-hd-old-we", set_no: 1, reps: 5, weight: 8, is_warmup: false, rir: 2, completed_at: before.toISOString() });
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
  await expect(page.getByText("Volume").first()).toBeVisible();
  await expect(page.getByText("Records", { exact: true })).toBeVisible();
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
  // Body map next to the stats.
  await expect(page.getByText("Front", { exact: true })).toBeVisible();
  await expect(page.getByText("Back", { exact: true })).toBeVisible();

  // The exercise is a card: name, set count, and a SET / WEIGHT & REPS / 1RM table.
  await expect(page.getByRole("heading", { name: "Exercises" })).toBeVisible();
  const card = page.getByRole("region", { name: "3/4 Sit-Up" });
  await expect(card.getByText("1 set", { exact: true })).toBeVisible();
  for (const h of ["Set", "Weight & reps"]) await expect(card.getByText(h, { exact: true })).toBeVisible();
  await expect(card.getByText("10kg × 5")).toBeVisible();
  // No est. 1RM anywhere: no column, no value, no badge.
  await expect(page.getByText(/1RM/)).toHaveCount(0);
  await expect(card.getByText("11.7")).toHaveCount(0);

  // 10 kg beats the earlier 8 kg: the set carries record badges.
  const badges = card.getByRole("list", { name: "Records" });
  await expect(badges.getByText("Weight", { exact: true })).toBeVisible();
  await expect(badges.getByText("Volume", { exact: true })).toBeVisible();
  // The Records total counts only the badges shown: weight and volume.
  await expect(page.getByText("Records", { exact: true }).locator("xpath=following-sibling::p")).toHaveText("2");

  // Editing still swaps the set row for weight and reps inputs.
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(card.getByRole("textbox")).toHaveCount(2);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(card.getByRole("textbox")).toHaveCount(0);
});
