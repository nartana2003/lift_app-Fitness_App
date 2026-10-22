import { test, expect } from "@playwright/test";

// SOC-02: /save?url= (the iOS Shortcut target) opens Save from link with the
// link prefilled. No AI key in e2e, so reading answers 503 with a plain message.
const LINK = "https://www.tiktok.com/@coach/video/123";

test("save page prefills the shared link and keeps the existing flow", async ({ page }) => {
  await page.goto(`/save?url=${encodeURIComponent(LINK)}`);
  await page.waitForLoadState("networkidle");

  await expect(page.getByText("Save from link")).toBeVisible();
  await expect(page.getByLabel("Video link")).toHaveValue(LINK);
  await expect(page.getByText("Link added. Paste the caption or describe the workout, then tap Read workout.")).toBeVisible();

  await page.getByLabel("Caption").fill("3x20 crunches, 3x12 push ups");
  const answered = page.waitForResponse((r) => r.url().includes("/api/ai/social-import"));
  await page.getByRole("button", { name: "Read workout" }).click();
  expect((await answered).status()).toBe(503);
  await expect(
    page.getByText("Reading workouts from links is not available right now. You can still build routines by hand."),
  ).toBeVisible();
});

test("save page without a valid link shows the empty paste box and a hint", async ({ page }) => {
  await page.goto("/save?url=not-a-link");
  await page.waitForLoadState("networkidle");

  await expect(page.getByLabel("Video link")).toHaveValue("");
  await expect(page.getByText("No link came through. Paste a TikTok, Instagram or YouTube link.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Read workout" })).toBeVisible();
});
