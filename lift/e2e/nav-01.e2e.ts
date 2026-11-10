import { test, expect } from "@playwright/test";

// NAV-01: My Routines moved from Home to the Exercises tab behind an
// Exercises | Routines switch. Create, start and delete a routine from there,
// and check Home no longer lists routines. No AI involved.
const NAME = "E2E NAV Push";

test("routines live on Exercises > Routines: create, start, delete", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());

  // Home: no My Routines section.
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: "Start Workout" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "My Routines" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "New routine" })).toHaveCount(0);

  // Exercises tab defaults to Exercises; switch to Routines.
  await page.goto("/exercises");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("radio", { name: "Exercises" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByPlaceholder("Search for exercises")).toBeVisible();
  await page.getByRole("radio", { name: "Routines" }).click();
  await expect(page).toHaveURL(/view=routines/);
  await expect(page.getByRole("radio", { name: "Routines" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("heading", { name: "Routines", exact: true })).toBeVisible();

  // Create.
  await page.getByRole("link", { name: "New routine" }).click();
  await expect(page.getByRole("heading", { name: "New routine" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("Routine name (e.g. Push day)").fill(NAME);
  await page.getByRole("button", { name: "+ Add exercise" }).click();
  await page.getByPlaceholder("Search for exercises").fill("Pushups");
  await page.getByText("Pushups", { exact: true }).first().click();
  await page.getByRole("button", { name: "Add 1 exercise" }).click();
  await page.getByRole("button", { name: "Create routine" }).click();

  // Back on the Routines view with the new card.
  await expect(page).toHaveURL(/\/exercises\?view=routines/);
  const card = page.getByRole("listitem").filter({ hasText: NAME });
  await expect(card).toBeVisible();

  // Start.
  await card.getByRole("button", { name: "Start" }).click();
  await expect(page).toHaveURL(/\/workout/);

  // Delete.
  await page.goto("/exercises?view=routines");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: `Options for ${NAME}` }).click();
  await page.getByRole("link", { name: "Edit routine" }).click();
  await expect(page.getByRole("heading", { name: "Edit routine" })).toBeVisible();
  await page.goBack();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: `Options for ${NAME}` }).click();
  await page.getByRole("button", { name: "Delete routine" }).click();
  await expect(page.getByText(NAME)).toHaveCount(0);

  // Home still lists no routines.
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Weekly Snapshot" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "My Routines" })).toHaveCount(0);

  expect(errors).toEqual([]);
});
