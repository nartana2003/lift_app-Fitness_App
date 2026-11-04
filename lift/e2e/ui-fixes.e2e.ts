import { test, expect } from "@playwright/test";

// Routines header and menu, all muscle chips, gym day panel, no Home coach card,
// no week label in history, custom exercise and card collapse in a live workout,
// and the single finish sheet. All local; no Supabase or AI key.
const NAME = "Fixes routine";

test("Routines view: title, + in the header, all muscle chips, delete from the three dots", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await page.goto("/exercises?view=routines");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Routines", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Exercises", exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "New routine" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("Routine name (e.g. Push day)").fill(NAME);
  await page.getByRole("button", { name: "+ Add exercise" }).click();
  await page.getByPlaceholder("Search for exercises").fill("Pushups");
  await page.getByText("Pushups", { exact: true }).first().click();
  await page.getByRole("button", { name: "Add 1 exercise" }).click();
  await page.getByRole("button", { name: "Create routine" }).click();
  await expect(page.getByText(NAME)).toBeVisible();

  // Same muscle row as the Exercises view.
  const routineChips = await page.getByRole("group", { name: "Filter by muscle" }).getByRole("button").count();
  await page.getByRole("radio", { name: "Exercises" }).click();
  await expect(page.getByPlaceholder("Search for exercises")).toBeVisible();
  const exerciseChips = (await page.locator("button[aria-pressed]").count()) - 1; // minus Favorites
  expect(routineChips).toBe(exerciseChips);
  await expect(page.getByRole("heading", { name: "Exercises", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Routines" }).click();

  await page.getByRole("button", { name: `Options for ${NAME}` }).click();
  await page.getByRole("button", { name: "Delete routine" }).click();
  await expect(page.getByText(NAME)).toHaveCount(0);
});

test("Home: gym day panel has a Close icon and a Remove gym day button; no Coach card; no week label", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("link", { name: /Build or optimise your split/ })).toHaveCount(0);
  await expect(page.getByText(/^Week of /)).toHaveCount(0);

  await page.locator("[data-day][aria-label*='tap to mark']").first().click();
  const remove = page.getByRole("button", { name: "Remove gym day" });
  await expect(remove).toBeVisible();
  await expect(remove.locator("svg")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(remove).toHaveCount(0);

  await page.locator("[data-day][aria-label*='gym day, tap to change']").first().click();
  await remove.click();
  await expect(remove).toHaveCount(0);
  await expect(page.locator("[data-day][aria-label*='gym day, tap to change']")).toHaveCount(0);
});

test("Live workout: create a missing exercise, collapse its card, finish on one sheet", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Start Workout" }).click();
  await expect(page).toHaveURL(/\/workout/);
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "+ Add exercise" }).click();
  await page.getByRole("button", { name: "New exercise" }).click();
  await page.getByPlaceholder("e.g. Lever Hip Abduction").fill("Zzz Custom Curl");
  await page.getByRole("button", { name: "Biceps", exact: true }).click();
  await page.getByRole("button", { name: "Create exercise" }).click();

  const card = page.getByRole("heading", { name: "Zzz Custom Curl" });
  await expect(card).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Add set" })).toBeVisible();

  // Tap the card title: only the picture and name stay.
  await page.getByRole("button", { name: "Collapse Zzz Custom Curl" }).click();
  await expect(page.getByRole("button", { name: "+ Add set" })).toHaveCount(0);
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: "Expand Zzz Custom Curl" }).click();
  await expect(page.getByRole("button", { name: "+ Add set" })).toBeVisible();

  // Log one set and finish.
  await page.locator("input[inputmode='numeric']").first().fill("10");
  await page.getByRole("button", { name: "Complete set" }).first().click();
  await page.getByRole("button", { name: "Finish" }).click();
  await page.getByRole("button", { name: "Save workout" }).click();

  // Photos and Save as routine are on one sheet.
  await expect(page.getByRole("button", { name: "Take front photo" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Save as routine" })).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/history\//);

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "My History" })).toBeVisible();
  await expect(page.getByText(/^Week of /)).toHaveCount(0);
});
