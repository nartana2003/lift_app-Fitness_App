import { test, expect, type Page } from "@playwright/test";

// Resume lives on Home only, the live workout's Discard became "Delete workout",
// sets delete by swiping left, and history cards delete from a three-dot menu.

const put = (page: Page, store: string, rows: object[]) =>
  page.evaluate(
    ([s, r]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("lift");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(s as string, "readwrite");
          for (const row of r as object[]) tx.objectStore(s as string).put(row);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    [store, rows] as const,
  );

const sets = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, reps: 8, weight: 50, is_warmup: false, rir: null, done: false }));

test("running workout: Home has Resume, tab bar does not, Delete workout and swipe delete work", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await put(page, "active", [
    {
      key: "active",
      id: "w1",
      started_at: new Date().toISOString(),
      routine_id: null,
      name: null,
      exercises: [{ id: "e1", exercise_id: "bench-press", sets: sets(3) }],
    },
  ]);
  await page.reload();
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("navigation").getByRole("link", { name: "Resume" })).toHaveCount(0);
  await page.getByRole("link", { name: "Resume workout" }).click();
  await expect(page).toHaveURL(/\/workout$/);

  await expect(page.getByRole("button", { name: /− Set/ })).toHaveCount(0);
  const ticks = page.getByRole("button", { name: "Complete set" });
  await expect(ticks).toHaveCount(3);
  const row = ticks.nth(1).locator("..").locator("..");
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + box.width - 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 160, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(ticks).toHaveCount(2);

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete workout" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Resume workout" })).toHaveCount(0);
});

test("history card three-dot menu deletes a workout", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const start = new Date(Date.now() - 864e5);
  await put(page, "workouts", [
    {
      id: "h1",
      started_at: start.toISOString(),
      ended_at: new Date(start.getTime() + 3e6).toISOString(),
      notes: "Delete me",
      routine_id: null,
    },
  ]);
  await page.reload();
  await page.waitForLoadState("networkidle");

  await expect(page.getByText("Delete me")).toBeVisible();
  await page.getByRole("button", { name: "Workout options" }).click();
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Delete workout" }).click();
  await expect(page.getByText("Delete me")).toBeVisible();

  await page.getByRole("button", { name: "Workout options" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete workout" }).click();
  await expect(page.getByText("Delete me")).toHaveCount(0);
});
