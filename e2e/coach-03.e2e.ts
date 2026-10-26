import { test, expect } from "@playwright/test";

// COACH-03: guided Coach setup in Profile > Goals. There is no AI key in e2e, so
// suggest-split and review-setup answer 503: the split and the review are built
// from the rules in the browser and a plain note says AI is unavailable.

test("coach setup walks the steps on the unavailable path and saves the goal and day count", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /^Goals/ }).click();
  await page.getByRole("button", { name: "Set up with coach" }).click();

  const panel = page.getByRole("region", { name: "Coach setup" });
  const nav = panel.getByRole("group", { name: "Step navigation" });
  await expect(panel.getByRole("heading", { name: "What do you want" })).toBeVisible();

  // 1) Goal and typed goal.
  await panel.getByRole("button", { name: "Get stronger" }).click();
  await panel.getByLabel("Your goal in your own words").fill("Stronger legs");
  await nav.getByRole("button", { name: "Next" }).click();

  // 2) Days a week.
  await expect(panel.getByRole("heading", { name: "Focus and days" })).toBeVisible();
  await panel.getByLabel("Days a week").fill("5");
  await expect(panel.getByTestId("coach-days")).toHaveText("5");
  await nav.getByRole("button", { name: "Next" }).click();

  // 3) No split yet: Build is the default and the rule split is built.
  await expect(panel.getByRole("heading", { name: "Your split" })).toBeVisible();
  await panel.getByRole("button", { name: "Build split" }).click();
  await expect(panel.getByText("AI is unavailable right now, so this uses the built-in rules.")).toBeVisible();
  await expect(panel.getByRole("list", { name: "Proposed split" })).toBeVisible();
  await panel.getByRole("button", { name: "Use this split" }).click();
  await expect(panel.getByText("This split will be saved when you tap Save.")).toBeVisible();
  await nav.getByRole("button", { name: "Next" }).click();

  // 4) Exercises.
  await expect(panel.getByRole("heading", { name: "Your exercises" })).toBeVisible();
  await nav.getByRole("button", { name: "Next" }).click();

  // 5) Review from the rules.
  await expect(panel.getByRole("heading", { name: "Review" })).toBeVisible();
  await expect(panel.getByText("AI is unavailable right now, so this uses the built-in rules.")).toBeVisible();
  await expect(panel.getByRole("list", { name: "Review" })).toBeVisible();
  await nav.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("Coach setup saved.")).toBeVisible();
  await expect(page.getByText("Workouts per week · 5")).toBeVisible();
  // The Goals card shows its summary only while collapsed.
  const goalsHeader = page.getByRole("button", { name: /^Goals/ });
  await goalsHeader.click();
  await expect(goalsHeader).toHaveAttribute("aria-expanded", "false");
  await expect(goalsHeader).toContainText("Get stronger · 5×/week");
});
