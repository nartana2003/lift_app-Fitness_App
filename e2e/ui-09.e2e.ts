import { test, expect } from "@playwright/test";

// UI-09: "Save from link" on Home. There is no AI key in e2e, so the
// social-import route answers 503: a plain message shows, nothing is saved,
// and the manual routine flow is still there.
test("save from link shows a plain message when AI is unavailable", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await expect(page.getByText("Save from link")).toBeVisible();
  await page.getByRole("button", { name: "Paste link" }).click();

  await page.getByLabel("Video link").fill("https://www.tiktok.com/@coach/video/123");
  await page.getByLabel("Caption").fill("3x20 crunches, 3x12 push ups");

  const answered = page.waitForResponse((r) => r.url().includes("/api/ai/social-import"));
  await page.getByRole("button", { name: "Read workout" }).click();
  expect((await answered).status()).toBe(503);

  await expect(
    page.getByText("Reading workouts from links is not available right now. You can still build routines by hand."),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "Imported exercises" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "New routine" })).toBeVisible();
});
