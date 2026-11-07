import { test, expect, type Page } from "@playwright/test";

// Profile > Feedback. Blank Supabase and a blank GITHUB_FEEDBACK_TOKEN
// (playwright.config.ts), so the real route answers 503 and no spec can open a
// real GitHub issue. The send and status-list cases stub /api/feedback.

async function openFeedback(page: Page) {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Feedback/ }).click();
}

test("sends feedback and thanks the user", async ({ page }) => {
  const posted: unknown[] = [];
  await page.route("**/api/feedback", async (route) => {
    if (route.request().method() === "POST") {
      posted.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, number: 12 } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await openFeedback(page);

  const box = page.getByLabel("Feedback message");
  await box.fill("  Please add a plate calculator  ");
  await expect(page.getByText("33 / 2000")).toBeVisible();
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Thanks, your feedback was sent.")).toBeVisible();
  await expect(box).toHaveValue("");
  expect(posted).toEqual([{ message: "Please add a plate calculator" }]);
});

test("shows the not-set-up message from the real route and keeps the text", async ({ page }) => {
  await openFeedback(page);
  await page.getByLabel("Feedback message").fill("Keep this text");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Feedback is not set up yet.")).toBeVisible();
  await expect(page.getByLabel("Feedback message")).toHaveValue("Keep this text");
});

test("lists past feedback with Open and Fixed status", async ({ page }) => {
  await page.route("**/api/feedback", (route) =>
    route.fulfill({
      json: {
        items: [
          { number: 2, message: "Louder rest timer", created_at: "2026-11-02T10:00:00Z", status: "fixed" },
          { number: 1, message: "Dark mode please", created_at: "2026-11-01T10:00:00Z", status: "open" },
        ],
      },
    }),
  );
  await openFeedback(page);
  const list = page.getByRole("list", { name: "Your feedback" });
  await expect(list.getByText("Louder rest timer")).toBeVisible();
  await expect(list.getByText("Fixed")).toHaveClass(/chip-on/);
  await expect(list.getByText("Open")).toBeVisible();
});

test("real route: 503 without a token, empty list in local-only mode", async ({ request }) => {
  const post = await request.post("/api/feedback", { data: { message: "hi" } });
  expect(post.status()).toBe(503);
  expect(await post.json()).toEqual({ unavailable: true });

  const get = await request.get("/api/feedback");
  expect(get.status()).toBe(200);
  expect(await get.json()).toEqual({ items: [] });
});

test("other Profile sections still open beside Feedback", async ({ page }) => {
  await openFeedback(page);
  await page.getByRole("button", { name: /^Preferences/ }).click();
  await expect(page.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
  await expect(page.getByLabel("Feedback message")).toBeVisible();
});
