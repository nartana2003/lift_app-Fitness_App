import { test, expect } from "@playwright/test";

// SOC-03: Fetch details on Save from link. An Instagram link has no public
// oEmbed, so /api/social/import answers manual without any outbound fetch and
// the paste-the-caption flow carries on as before (no AI key in e2e: 503).
const LINK = "https://www.instagram.com/reel/abc/";

test("fetch details falls back to the paste flow for a link with no details", async ({ page }) => {
  await page.goto(`/save?url=${encodeURIComponent(LINK)}`);
  await page.waitForLoadState("networkidle");

  await expect(page.getByLabel("Video link")).toHaveValue(LINK);
  const details = page.waitForResponse((r) => r.url().includes("/api/social/import"));
  await page.getByRole("button", { name: "Fetch details" }).click();
  expect((await details).status()).toBe(200);
  await expect(page.getByText("No details for this link. Paste the caption or describe the workout.")).toBeVisible();
  await expect(page.getByLabel("Caption")).toHaveValue("");

  await page.getByLabel("Caption").fill("3x20 crunches");
  const answered = page.waitForResponse((r) => r.url().includes("/api/ai/social-import"));
  await page.getByRole("button", { name: "Read workout" }).click();
  expect((await answered).status()).toBe(503);
  await expect(
    page.getByText("Reading workouts from links is not available right now. You can still build routines by hand."),
  ).toBeVisible();
});
