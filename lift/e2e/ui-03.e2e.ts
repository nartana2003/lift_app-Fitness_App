import { test, expect, type Page } from "@playwright/test";

// UI-03: weekly goals card on Progress. A fresh profile has no workouts, so every
// muscle is under its default target and the rule-based "Catch up" plan renders
// without seeding. There is no AI key in e2e, so "Refine with AI" must show the
// plain unavailable/failure note and leave the plan exactly as it was.
const BENCH = "Barbell_Bench_Press_-_Medium_Grip";

const card = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Weekly goals" }) });

async function openDb(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift"))).toBe(true);
}

/** Puts a routine with one exercise in the db and plans it for today, the way a sync pull or old data would (no favourites entry). */
async function seedPlannedRoutine(page: Page) {
  await page.evaluate(async (bench) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const tx = db.transaction(["routines", "routine_exercises", "planned_days"], "readwrite");
    tx.objectStore("routines").put({
      id: "e2e-ui03-r",
      name: "E2E Push",
      day_label: null,
      source: "manual",
      kind: "routine",
      source_url: null,
      platform: null,
      thumbnail_url: null,
      creator: null,
      notes: null,
      created_at: new Date().toISOString(),
    });
    tx.objectStore("routine_exercises").put({ id: "e2e-ui03-e0", routine_id: "e2e-ui03-r", exercise_id: bench, position: 0, target_sets: 4, target_reps: "6-8" });
    tx.objectStore("planned_days").put({
      id: "e2e-ui03-day",
      date: today,
      routine_id: "e2e-ui03-r",
      status: "planned",
      workout_id: null,
      skip_reason: null,
      skip_note: null,
      moved_to: null,
      moved_from: null,
      created_at: new Date().toISOString(),
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, BENCH);
}

test("weekly goals card shows the catch-up plan and a plain note when AI is unavailable", async ({ page }) => {
  await page.goto("/progress");
  await page.waitForLoadState("networkidle"); // let React hydrate before clicking

  const c = card(page);
  await expect(c.getByRole("heading", { name: "Weekly goals" })).toBeVisible();
  await expect(c.getByRole("heading", { name: "Catch up" })).toBeVisible();

  // The plan is rule-based: exercise links per training day, with a one-tap add, and no AI call needed.
  const plan = c.getByRole("list", { name: "Catch-up plan" });
  await expect(plan).toBeVisible();
  const links = plan.locator('a[href^="/exercises/"]');
  await expect(links.first()).toBeVisible();
  const linkCount = await links.count();
  await expect(plan.getByRole("button", { name: "Add to next workout" })).toBeVisible();

  await c.getByRole("button", { name: "Refine with AI" }).click();
  await expect(
    c.getByText(/AI refine is not available right now|Could not refine the plan with AI|AI refine is available when back online/),
  ).toBeVisible();

  // Rule-based plan unchanged by the failed refine.
  await expect(links).toHaveCount(linkCount);
  await expect(plan.getByRole("button", { name: "Add to next workout" })).toBeVisible();
});

test("catch-up adds sets to the planned routine as a copy and does not star exercises", async ({ page }) => {
  await openDb(page);
  await seedPlannedRoutine(page);
  await page.goto("/progress");
  await page.waitForLoadState("networkidle");

  const c = card(page);
  const today = await page.evaluate(() => new Date().toLocaleDateString(undefined, { weekday: "short" }));
  const plan = c.getByRole("list", { name: "Catch-up plan" });
  // Chest work lands on the day whose routine already trains chest, as more sets on that exercise.
  const todayBlock = plan.getByRole("listitem").filter({ has: page.getByText(today, { exact: true }) }).first();
  await expect(todayBlock.getByText(/more on .*Bench Press.*, already in E2E Push/)).toBeVisible();

  // The routine's 4 planned bench sets already count toward chest, so they are not asked for again.
  await expect(c.getByText(/Already covered by your planned routines: .*Chest \(4 sets\)/)).toBeVisible();

  await todayBlock.getByRole("button", { name: /Add to/ }).click();
  await expect(c.getByText(`Added to E2E Push on ${today}.`)).toBeVisible();

  const result = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const all = <T,>(store: string) =>
      new Promise<T[]>((resolve, reject) => {
        const q = db.transaction(store).objectStore(store).getAll();
        q.onsuccess = () => resolve(q.result as T[]);
        q.onerror = () => reject(q.error);
      });
    const routines = await all<{ id: string; name: string }>("routines");
    const exercises = await all<{ routine_id: string; exercise_id: string; target_sets: number }>("routine_exercises");
    const meta = await all<{ key: string; value: unknown }>("meta");
    db.close();
    const copy = routines.find((r) => r.name === "E2E Push + catch up");
    return {
      names: routines.map((r) => r.name).sort(),
      copy: exercises.filter((e) => e.routine_id === copy?.id).map((e) => ({ id: e.exercise_id, sets: e.target_sets })),
      originalSets: exercises.filter((e) => e.routine_id === "e2e-ui03-r").map((e) => e.target_sets),
      favourites: meta.find((m) => m.key === "favorites")?.value ?? null,
    };
  });
  expect(result.names).toEqual(["E2E Push", "E2E Push + catch up"]);
  expect(result.originalSets).toEqual([4]);
  // The planned exercise gets the extra sets; at most 3 additions land on one day.
  expect(result.copy.find((e) => e.id === BENCH)!.sets).toBeGreaterThan(4);
  expect(result.copy.length).toBeLessThanOrEqual(3);
  // The plan's own picks are never starred.
  expect(result.favourites === null || (result.favourites as string[]).length === 0).toBe(true);
});
