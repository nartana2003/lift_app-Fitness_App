import { test, expect } from "@playwright/test";

// SOC-06: Save from link saves as a routine (default) or as an exercise; the
// mini workout save is no longer offered. No AI key in e2e, so reading the
// post answers 503 with a plain message, and nothing leaves the app's origin.
const LINK = "https://www.tiktok.com/@coach/video/123";

test("save from link shows the routine or exercise description and makes no outside call", async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? "http://localhost:3100").origin;
  const outside: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.startsWith("data:") || u.startsWith("blob:")) return;
    if (new URL(u).origin !== origin) outside.push(u);
  });

  await page.goto(`/save?url=${encodeURIComponent(LINK)}`);
  await page.waitForLoadState("networkidle");

  await expect(
    page.getByText("Save a workout from a TikTok, Instagram or YouTube link as a routine, or a single move as an exercise."),
  ).toBeVisible();
  await expect(page.getByText("as a mini workout")).toHaveCount(0);
  await expect(page.getByLabel("Video link")).toHaveValue(LINK);

  await page.getByLabel("Caption").fill("3x20 crunches, 3x30s hollow hold");
  const answered = page.waitForResponse((r) => r.url().includes("/api/ai/social-import"));
  await page.getByRole("button", { name: "Read workout" }).click();
  expect((await answered).status()).toBe(503);
  await expect(
    page.getByText("Reading workouts from links is not available right now. You can still build routines by hand."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /mini workout/i })).toHaveCount(0);

  expect(outside).toEqual([]);
});
