import { test, expect } from "@playwright/test";

// Issue #7: the Exercises tab has a Cardio filter that lists the cardio exercises.

test("cardio tab lists cardio exercises and toggles off", async ({ page }) => {
  await page.goto("/exercises");
  await expect(page.getByRole("heading", { name: "Bench Press" }).first()).toBeVisible();

  const cardio = page.getByRole("button", { name: "Cardio", exact: true });
  await cardio.click();
  await expect(page).toHaveURL(/m=Cardio/);
  await expect(cardio).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Recumbent Bike" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Rope Jumping" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bench Press" })).toHaveCount(0);
  await expect(page.getByText("14 exercises")).toBeVisible();

  await cardio.click();
  await expect(page).not.toHaveURL(/m=/);
  await expect(page.getByRole("heading", { name: "Bench Press" }).first()).toBeVisible();
});

test("cardio tab works from the add exercises picker in a workout", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Start Workout" }).click();
  await expect(page).toHaveURL(/\/workout$/);
  await page.getByRole("button", { name: "+ Add exercise" }).click();
  await expect(page.getByRole("heading", { name: "Add exercises" })).toBeVisible();

  await page.getByRole("button", { name: "Cardio", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Recumbent Bike" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bench Press" })).toHaveCount(0);
});

test("a muscle tab still shows its exercises", async ({ page }) => {
  await page.goto("/exercises?m=Chest");
  await expect(page.getByRole("heading", { name: "Bench Press" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recumbent Bike" })).toHaveCount(0);
});
