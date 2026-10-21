import { test, expect } from "@playwright/test";

// UI-03: weekly goals card on Progress. A fresh profile has no workouts, so
// every muscle is under its default target and the rule-based "Catch up"
// block renders without seeding. There is no AI key in e2e, so the AI button
// must show the plain unavailable/failure note and leave the chips in place.
test("weekly goals card shows catch-up chips and a plain note when AI is unavailable", async ({ page }) => {
  await page.goto("/progress");
  await page.waitForLoadState("networkidle"); // let React hydrate before clicking

  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Weekly goals" }) });
  await expect(card.getByRole("heading", { name: "Weekly goals" })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Catch up" })).toBeVisible();

  // Rule-based chips are links to exercise detail pages.
  const chips = card.locator('a[href^="/exercises/"]');
  await expect(chips.first()).toBeVisible();
  const chipCount = await chips.count();

  await card.getByRole("button", { name: "Plan the week with AI" }).click();

  await expect(
    card.getByText(/AI plan is not available right now|Could not get an AI plan|AI plan is available when back online/),
  ).toBeVisible();

  // Rule-based behaviour unchanged: same chips, no AI plan list, no add button.
  await expect(chips).toHaveCount(chipCount);
  await expect(card.getByRole("list", { name: "AI catch-up plan" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Add to next workout" })).toHaveCount(0);
});
