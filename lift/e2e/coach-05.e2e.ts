import { test, expect } from "@playwright/test";

// COACH-05: opt-in "Find evidence-backed exercises" on the Review step of Coach
// setup. There is no AI key in e2e, so evidence-picks answers 503: the panel
// shows the built-in rule suggestions with a plain limited-evidence note, no
// citations and no sources, and the fixed disclaimer.

test("evidence search on the unavailable path shows the rule suggestions and the disclaimer", async ({ page }) => {
  await page.goto("/coach");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /^Goals/ }).click();
  await page.getByRole("button", { name: "Set up with coach" }).click();

  const panel = page.getByRole("region", { name: "Coach setup" });
  const nav = panel.getByRole("group", { name: "Step navigation" });
  await nav.getByRole("button", { name: "Next" }).click();

  // Focus muscle so the review has a muscle to search for.
  await expect(panel.getByRole("heading", { name: "Focus and days" })).toBeVisible();
  await panel.getByRole("button", { name: "Chest", exact: true }).click();
  await nav.getByRole("button", { name: "Next" }).click();
  await nav.getByRole("button", { name: "Next" }).click();
  await nav.getByRole("button", { name: "Next" }).click();

  await expect(panel.getByRole("heading", { name: "Review" })).toBeVisible();
  const evidence = panel.getByRole("region", { name: "Evidence-backed exercises" });
  await expect(evidence).toBeVisible();
  await expect(
    evidence.getByText("General fitness information, not medical advice. Research on the best exercise is limited and findings can conflict."),
  ).toBeVisible();

  const find = evidence.getByRole("button", { name: "Find evidence-backed exercises" });
  await expect(find).toBeEnabled();
  await find.click();

  await expect(
    evidence.getByText("Research search is unavailable right now. These suggestions come from the built-in rules, so the evidence is limited."),
  ).toBeVisible();
  await expect(evidence.getByRole("list", { name: "Built-in suggestions for Chest" })).toBeVisible();
  await expect(evidence.getByText("Evidence: limited")).toBeVisible();
  await expect(evidence.getByRole("list", { name: "Sources" })).toHaveCount(0);
});
