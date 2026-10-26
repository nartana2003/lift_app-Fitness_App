import { test, expect } from "@playwright/test";

// COACH-06: "Ask the coach" card on Profile. There is no AI key in e2e, so
// /api/ai/ask-coach answers 503: the card shows a plain message and hints from
// the built-in rules (a fresh browser has no split yet), and no answer.

test("ask the coach on the unavailable path shows a plain message and rule hints", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");

  const header = page.getByRole("button", { name: /^Ask the coach/ });
  await expect(header).toBeVisible();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();

  const box = page.getByLabel("Your question for the coach");
  await expect(box).toBeVisible();
  const ask = page.getByRole("button", { name: "Ask", exact: true });
  await expect(ask).toBeDisabled();

  await box.fill("What should I train this week?");
  await expect(ask).toBeEnabled();
  await ask.click();

  await expect(page.getByText("The coach is not available right now.")).toBeVisible();
  const hints = page.getByRole("list", { name: "From the built-in rules" });
  await expect(hints).toBeVisible();
  await expect(hints.getByText(/You have no split yet/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Coach answer" })).toHaveCount(0);
});
