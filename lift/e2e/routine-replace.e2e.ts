import { test, expect, type Page } from "@playwright/test";

// CO-07: the per-exercise options menu in the routine editor. Replace swaps one
// exercise for another that trains the same muscle and keeps its sets, reps and
// place; "I don't like this" saves it to the never-suggest list. No AI key in e2e,
// so the swap-exercise route answers 503 and the rule-based alternatives show.

const seed = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("lift");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(["routines", "routine_exercises"], "readwrite");
          tx.objectStore("routines").put({
            id: "rt1",
            name: "Arms",
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
          tx.objectStore("routine_exercises").put({ id: "re1", routine_id: "rt1", exercise_id: "Barbell_Curl", position: 0, target_sets: 4, target_reps: "6-8" });
          tx.objectStore("routine_exercises").put({ id: "re2", routine_id: "rt1", exercise_id: "Triceps_Pushdown", position: 1, target_sets: 3, target_reps: "10" });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
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

async function openEditor(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await seed(page);
  await page.goto("/routines/rt1");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: "Options for Barbell Curl" })).toBeVisible();
}

test("replace one exercise from its options menu and keep its sets, reps and place", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("button", { name: "Options for Barbell Curl" }).click();
  const sheet = page.getByRole("dialog", { name: "Replace Barbell Curl" });
  await expect(sheet).toBeVisible();

  // The reason chips and the Why panel.
  for (const label of ["Replace", "Equipment unavailable", "Too difficult", "Causes discomfort"]) {
    await expect(sheet.getByRole("button", { name: label })).toBeVisible();
  }
  await sheet.getByRole("button", { name: "Why is this exercise here?" }).click();
  await expect(sheet.getByText("Barbell Curl trains biceps.")).toBeVisible();

  // Alternatives are for the same muscle and never the exercise itself or another row.
  await sheet.getByRole("button", { name: "Equipment unavailable" }).click();
  const list = sheet.getByRole("list", { name: "Alternatives" });
  await expect(list.getByRole("button").first()).toBeVisible();
  await expect(list.getByText("Top pick")).toHaveCount(1);
  await expect(list.getByRole("button", { name: /^Barbell Curl/ })).toHaveCount(0);
  await expect(list.getByRole("button", { name: /Triceps Pushdown/ })).toHaveCount(0);
  const picked = (await list.getByRole("button").first().locator(".font-medium").innerText()).trim();
  await list.getByRole("button").first().click();

  await expect(sheet).toHaveCount(0);
  await expect(page.getByText("Barbell Curl", { exact: true })).toHaveCount(0);
  await expect(page.getByText(picked, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Triceps Pushdown", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).not.toHaveURL(/\/routines\/rt1$/);

  const rows = ((await readAll(page, "routine_exercises")) as { routine_id: string; exercise_id: string; position: number; target_sets: number; target_reps: string }[])
    .filter((r) => r.routine_id === "rt1")
    .sort((a, b) => a.position - b.position);
  expect(rows).toHaveLength(2);
  expect(rows[0].exercise_id).not.toBe("Barbell_Curl");
  expect(rows[0]).toMatchObject({ position: 0, target_sets: 4, target_reps: "6-8" });
  expect(rows[1]).toMatchObject({ exercise_id: "Triceps_Pushdown", position: 1, target_sets: 3, target_reps: "10" });
});

test("I don't like this saves the exercise to the never-suggest list", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("button", { name: "Options for Barbell Curl" }).click();
  const sheet = page.getByRole("dialog", { name: "Replace Barbell Curl" });
  await sheet.getByRole("button", { name: "I don't like this" }).click();
  await expect(sheet.getByText(/Barbell Curl will not be suggested again/)).toBeVisible();
  await expect(sheet.getByRole("button", { name: "I don't like this" })).toBeDisabled();

  await expect.poll(async () => ((await readAll(page, "meta")) as { key: string; value: { dislikedIds?: string[] } }[]).find((m) => m.key === "goals")?.value.dislikedIds).toEqual(["Barbell_Curl"]);

  // Still able to pick a replacement, and the routine itself is unchanged until saved.
  await sheet.getByRole("list", { name: "Alternatives" }).getByRole("button").first().click();
  await expect(sheet).toHaveCount(0);
  const rows = ((await readAll(page, "routine_exercises")) as { routine_id: string; exercise_id: string }[]).filter((r) => r.routine_id === "rt1");
  expect(rows.map((r) => r.exercise_id).sort()).toEqual(["Barbell_Curl", "Triceps_Pushdown"]);
});

test("Cancel closes the menu and changes nothing", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("button", { name: "Options for Triceps Pushdown" }).click();
  await page.getByRole("dialog", { name: "Replace Triceps Pushdown" }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Triceps Pushdown", { exact: true })).toBeVisible();
});
