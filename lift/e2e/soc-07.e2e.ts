import { test, expect } from "@playwright/test";

// SOC-07: Save from link can save the moves as exercises and group them in a
// routine in one go. The AI answer is mocked on the app's own origin; no key
// is needed and nothing leaves the app.
const LINK = "https://www.tiktok.com/@coach/video/123";

const answer = {
  name: "Core finisher",
  notes: null,
  exercises: [
    { exercise_id: null, name: "Hollow hold zq", muscle_groups: ["Abs/Core"], equipment: "Bodyweight", target_sets: 3, target_reps: "30s" },
    { exercise_id: null, name: "Bear crawl zq", muscle_groups: ["Shoulders"], equipment: "Bodyweight", target_sets: 3, target_reps: "10" },
  ],
};

test("Exercises + routine saves each move as an exercise with the link and a routine", async ({ page }) => {
  await page.route("**/api/ai/social-import", (route) => route.fulfill({ json: answer }));
  await page.route("**/api/social/import", (route) => route.fulfill({ json: { manual: true } }));

  await page.goto(`/save?url=${encodeURIComponent(LINK)}`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Caption").fill("30s hollow hold, 3x10 bear crawl");
  await page.getByRole("button", { name: "Read workout" }).click();

  await expect(page.getByRole("list", { name: "Imported exercises" })).toBeVisible();
  await page.getByRole("radio", { name: "Exercises + routine" }).check({ force: true });
  await expect(page.getByRole("group", { name: "Muscle groups for Hollow hold zq" })).toBeVisible();
  await expect(page.getByLabel("Sets for Bear crawl zq")).toBeVisible();

  await page.getByRole("button", { name: "Save exercises + routine" }).click();
  await expect(page.getByRole("status")).toContainText("Saved the exercises and Core finisher as a routine.");

  // The moves are now exercises with the link as their video.
  await page.goto("/exercises");
  await page.getByPlaceholder(/search/i).fill("Hollow hold zq");
  await page.getByText("Hollow hold zq").first().click();
  await expect(page.getByText("Watch original")).toBeVisible();

  // And the routine is listed on Home.
  await page.goto("/");
  await expect(page.getByText("Core finisher")).toBeVisible();
});

test("New exercise prefills an empty name from the pasted post title", async ({ page }) => {
  await page.route("**/api/social/import", (route) =>
    route.fulfill({ json: { platform: "tiktok", title: "Hip thrust form", creator: "coach", thumbnail_url: null } }),
  );
  await page.goto("/exercises/new");
  const video = page.getByPlaceholder("TikTok, Instagram or YouTube link");
  await video.fill(LINK);
  await video.blur();
  await expect(page.getByPlaceholder("e.g. Lever Hip Abduction")).toHaveValue("Hip thrust form");
});
