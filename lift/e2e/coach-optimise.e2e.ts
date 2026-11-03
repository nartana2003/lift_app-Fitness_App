import { test, expect, type Page } from "@playwright/test";

// CO-06: Coach > Optimise checks the saved split and its routines against the goals,
// lists changes to accept or reject, applies them and undoes them. There is no AI key
// in e2e, so /api/ai/optimise-split answers 503 and the rule changes are shown.

const now = new Date().toISOString();
const routine = (id: string, name: string, dayId: string) => ({
  id,
  name,
  day_label: null,
  source: "manual",
  kind: "routine",
  source_url: null,
  platform: null,
  thumbnail_url: null,
  creator: null,
  notes: null,
  created_at: now,
  split_day_id: dayId,
});

const seed = (page: Page) =>
  page.evaluate(
    ({ push, pull }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("lift");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(["meta", "routines", "routine_exercises", "workouts", "workout_exercises", "sets"], "readwrite");
          const meta = tx.objectStore("meta");
          meta.put({ key: "goals", value: { sessionsPerWeek: 2, priorities: { Biceps: "high" }, focusMuscles: ["Biceps"] } });
          meta.put({
            key: "split",
            value: {
              name: "Upper lower",
              days: [
                { id: "push", name: "Push", muscles: ["Chest"] },
                { id: "pull", name: "Pull", muscles: ["Lats", "Biceps"] },
              ],
            },
          });
          tx.objectStore("routines").put(push);
          tx.objectStore("routines").put(pull);
          const re = tx.objectStore("routine_exercises");
          re.put({ id: "re1", routine_id: "rpush", exercise_id: "Barbell_Bench_Press_-_Medium_Grip", position: 0, target_sets: 3, target_reps: "8-12" });
          re.put({ id: "re2", routine_id: "rpull", exercise_id: "Close-Grip_Front_Lat_Pulldown", position: 0, target_sets: 3, target_reps: "8-12" });
          re.put({ id: "re3", routine_id: "rpull", exercise_id: "Barbell_Curl", position: 1, target_sets: 3, target_reps: "10" });
          // A past workout done from the Pull routine.
          tx.objectStore("workouts").put({ id: "w1", started_at: "2026-10-01T10:00:00.000Z", ended_at: "2026-10-01T11:00:00.000Z", notes: null, routine_id: "rpull" });
          tx.objectStore("workout_exercises").put({ id: "we1", workout_id: "w1", exercise_id: "Barbell_Curl", position: 0 });
          tx.objectStore("sets").put({ id: "s1", workout_exercise_id: "we1", weight: 30, reps: 10, rpe: null, completed: true, position: 0 });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    { push: routine("rpush", "Push", "push"), pull: routine("rpull", "Pull", "pull") },
  );

const readAll = (page: Page, store: string) =>
  page.evaluate(
    (name) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const open = indexedDB.open("lift");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction(name).objectStore(name).getAll();
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        };
      }),
    store,
  );

const exercisesOf = async (page: Page, routineId: string) =>
  ((await readAll(page, "routine_exercises")) as { routine_id: string; exercise_id: string; position: number }[])
    .filter((e) => e.routine_id === routineId)
    .sort((a, b) => a.position - b.position)
    .map((e) => e.exercise_id);

const pastWorkout = async (page: Page) =>
  JSON.stringify([await readAll(page, "workouts"), await readAll(page, "workout_exercises"), await readAll(page, "sets")]);

test("optimise: accept, reject, apply all, undo; routines change and a past workout does not", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await seed(page);
  const workoutBefore = await pastWorkout(page);

  await page.goto("/coach");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Optimise/ }).click();
  await page.getByRole("button", { name: "Optimise my split" }).click();

  // Analysis with plain text badges and the Lift noticed line.
  const analysis = page.getByRole("region", { name: "Muscle analysis" });
  await expect(analysis).toBeVisible();
  await expect(analysis.getByRole("listitem").filter({ hasText: "Biceps" })).toContainText("Low");
  await expect(page.getByRole("region", { name: "Lift noticed" })).toContainText("Biceps is a high priority, but it is trained directly only once a week.");

  // Rule changes, with the unavailable note (no AI key in e2e).
  const changes = page.getByRole("region", { name: "Suggested changes" });
  await expect(changes.getByText("AI is unavailable right now, so this uses the built-in rules.")).toBeVisible();
  const pushCard = changes.getByRole("listitem").filter({ hasText: /to Push/ }).first();
  const pullCard = changes.getByRole("listitem").filter({ hasText: /to Pull/ }).first();
  for (const name of ["Accept", "Reject", "Swap exercise", "View Evidence"]) await expect(pullCard.getByRole("button", { name })).toBeVisible();

  await pullCard.getByRole("button", { name: "View Evidence" }).click();
  await expect(pullCard.getByRole("list", { name: "Evidence" })).toBeVisible();

  await pullCard.getByRole("button", { name: "Accept" }).click();
  await expect(pullCard).toContainText("Accepted");
  await pushCard.getByRole("button", { name: "Reject" }).click();
  await expect(pushCard).toContainText("Rejected");

  const pushBefore = await exercisesOf(page, "rpush");
  const pullBefore = await exercisesOf(page, "rpull");
  await changes.getByRole("button", { name: /^Apply all/ }).click();

  const updated = page.getByRole("region", { name: "Updated split" });
  await expect(updated).toBeVisible();
  await expect(updated).toContainText("Routines updated: Pull");
  await expect.poll(async () => (await exercisesOf(page, "rpull")).length).toBeGreaterThan(pullBefore.length);
  expect((await exercisesOf(page, "rpull")).slice(0, pullBefore.length)).toEqual(pullBefore);
  expect(await exercisesOf(page, "rpush")).toEqual(pushBefore);
  expect(await pastWorkout(page)).toBe(workoutBefore);

  // Undo puts the routines back; the past workout is still untouched.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undone. Your split and routines are back as they were.")).toBeVisible();
  await expect.poll(() => exercisesOf(page, "rpull")).toEqual(pullBefore);
  expect(await exercisesOf(page, "rpush")).toEqual(pushBefore);
  expect(await pastWorkout(page)).toBe(workoutBefore);
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
});
