import { test, expect } from "@playwright/test";

// GEN-03: the Generate plan card gains Favourites, Tell the coach and Build a
// split from this. No AI key in e2e, so suggest-split answers 503: a plain
// message appears with a split built without AI, which the user can use.
test("generate plan card builds a split from a typed request on the unavailable path", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await expect(page.getByText("Generate 3-day plan")).toBeVisible();
  const favourites = page.getByRole("button", { name: "Favourites", exact: true });
  await expect(favourites).toHaveAttribute("aria-expanded", "false");

  // Favourites picker opens with a catalogue search.
  await favourites.click();
  await expect(page.getByLabel("Search exercises")).toBeVisible();

  // Tell the coach, then Generate with no split offers Build a split first.
  await page.getByRole("button", { name: "Tell the coach", exact: true }).click();
  await page.getByRole("textbox", { name: "Tell the coach" }).fill("I want more arms and shoulders, 4 days a week");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByText("You have no split yet. Build one from your picks first, then generate a plan.")).toBeVisible();

  const answered = page.waitForResponse((r) => r.url().includes("/api/ai/suggest-split"));
  await page.getByRole("button", { name: "Build a split first" }).click();
  expect((await answered).status()).toBe(503);
  await expect(page.getByText("AI is not available right now. This split was built without AI from your picks.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Proposed split" })).toBeVisible();

  await page.getByRole("button", { name: "Use this split" }).click();
  await expect(page.getByText("Split saved.")).toBeVisible();
  await expect(page.getByText("Generate 4-day plan")).toBeVisible();
});
