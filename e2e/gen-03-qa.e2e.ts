import { test, expect, type Page } from "@playwright/test";

// QA for GEN-03 (independent). AI key is blank, so the AI routes answer 503.

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function open(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/Generate \d-day plan/)).toBeVisible();
}

async function noOverflow(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
}

async function typeRequest(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "Tell the coach" });
  if (!(await box.isVisible())) await page.getByRole("button", { name: "Tell the coach", exact: true }).click();
  await box.fill(text);
}

async function buildAndUse(page: Page, text: string) {
  await typeRequest(page, text);
  await page.getByRole("button", { name: "Build a split from this" }).click();
  await expect(page.getByRole("list", { name: "Proposed split" })).toBeVisible();
  await page.getByRole("button", { name: "Use this split" }).click();
}

test("card is collapsed by default, with no Build button and no overflow", async ({ page }) => {
  const errors = watchErrors(page);
  await open(page);
  await expect(page.getByRole("button", { name: "Favourites", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Tell the coach", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("Search exercises")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Build a split from this" })).toHaveCount(0);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("Generate with nothing used and no split shows the plain Profile message, not Build a split", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByText(/split/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Build a split first" })).toHaveCount(0);
});

test("coach box caps at 400 characters and Build appears only with text", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Tell the coach", exact: true }).click();
  const box = page.getByRole("textbox", { name: "Tell the coach" });
  await box.fill("x".repeat(900));
  expect((await box.inputValue()).length).toBe(400);
  await box.fill("   ");
  await expect(page.getByRole("button", { name: "Build a split from this" })).toHaveCount(0);
  await box.fill("more arms");
  await expect(page.getByRole("button", { name: "Build a split from this" })).toBeVisible();
});

test("favourites picker: search, add, remove, keyboard operable, narrow and wide", async ({ page }) => {
  const errors = watchErrors(page);
  await open(page);
  await page.getByRole("button", { name: "Favourites", exact: true }).click();
  const search = page.getByLabel("Search exercises");
  await search.fill("squat");
  const results = page.getByRole("list", { name: "Search results" });
  await expect(results).toBeVisible();
  const first = results.getByRole("button").first();
  const label = (await first.getAttribute("aria-label")) ?? "";
  const name = label.replace(/^Add /, "");
  await first.focus();
  await page.keyboard.press("Enter");
  const picked = page.getByRole("list", { name: "Picked exercises" });
  await expect(picked.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
  // an added exercise no longer appears as an add candidate
  await expect(results.getByRole("button", { name: `Add ${name}` })).toHaveCount(0);
  await noOverflow(page);
  await picked.getByRole("button", { name: `Remove ${name}` }).click();
  await expect(page.getByRole("list", { name: "Picked exercises" })).toHaveCount(0);
  await search.fill("zzzzqqq-nothing");
  await expect(page.getByRole("list", { name: "Search results" })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("picked favourites are for this plan only: gone after reload", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Favourites", exact: true }).click();
  await page.getByLabel("Search exercises").fill("curl");
  await page.getByRole("list", { name: "Search results" }).getByRole("button").first().click();
  await expect(page.getByRole("list", { name: "Picked exercises" })).toBeVisible();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Favourites", exact: true }).click();
  await expect(page.getByRole("list", { name: "Picked exercises" })).toHaveCount(0);
});

test("build split from picks: rapid taps give one proposal, Discard saves nothing", async ({ page }) => {
  const errors = watchErrors(page);
  await open(page);
  await page.getByRole("button", { name: "Favourites", exact: true }).click();
  await page.getByLabel("Search exercises").fill("bench");
  await page.getByRole("list", { name: "Search results" }).getByRole("button").first().click();
  await typeRequest(page, "legs and arms, 4 days a week");
  const build = page.getByRole("button", { name: "Build a split from this" });
  await build.dblclick().catch(() => undefined);
  await expect(page.getByRole("list", { name: "Proposed split" })).toHaveCount(1);
  await page.getByRole("button", { name: "Discard split" }).click();
  await expect(page.getByRole("list", { name: "Proposed split" })).toHaveCount(0);
  await page.reload();
  await page.waitForLoadState("networkidle");
  // nothing saved: wording unchanged from the no-split default
  await expect(page.getByText("Generate 3-day plan")).toBeVisible();
  expect(errors).toEqual([]);
});

test("saved split persists across reload, and replacing needs a confirm that Keep can cancel", async ({ page }) => {
  const errors = watchErrors(page);
  await open(page);
  await buildAndUse(page, "I want 4 days a week with arms");
  await expect(page.getByText("Split saved.")).toBeVisible();
  const label1 = await page.getByText(/Generate \d-day plan/).innerText();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(label1)).toBeVisible();

  // second build: replacing needs confirmation
  await typeRequest(page, "legs and glutes 5 days a week");
  await page.getByRole("button", { name: "Build a split from this" }).click();
  await expect(page.getByRole("list", { name: "Proposed split" })).toBeVisible();
  await page.getByRole("button", { name: "Use this split" }).click();
  await expect(page.getByText(/Replace your current split/)).toBeVisible();
  await expect(page.getByText("Split saved.")).toHaveCount(0);
  await page.getByRole("button", { name: "Keep current split" }).click();
  await expect(page.getByText(/Replace your current split/)).toHaveCount(0);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(label1)).toBeVisible();

  // confirm replaces
  await typeRequest(page, "legs and glutes 5 days a week");
  await page.getByRole("button", { name: "Build a split from this" }).click();
  await page.getByRole("button", { name: "Use this split" }).click();
  await page.getByRole("button", { name: "Replace split" }).click();
  await expect(page.getByText("Split saved.")).toBeVisible();
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("with a split, Generate and failed AI show a plain message and leave the card usable", async ({ page }) => {
  await open(page);
  await buildAndUse(page, "arms 3 days a week");
  await expect(page.getByText("Split saved.")).toBeVisible();
  await typeRequest(page, "more shoulders");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /not available|try again|could not/i }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  await expect(page.getByRole("list", { name: "Generated plan" })).toHaveCount(0);
});

test("generate while offline shows a message and sends no plan request", async ({ page, context }) => {
  await open(page);
  await buildAndUse(page, "arms 3 days a week");
  await expect(page.getByText("Split saved.")).toBeVisible();
  let calls = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/ai/")) calls++;
  });
  await context.setOffline(true);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /offline|online|connection/i }).first()).toBeVisible();
  expect(calls).toBe(0);
  await context.setOffline(false);
});

test("build split while offline falls back to a local proposal", async ({ page, context }) => {
  await open(page);
  await typeRequest(page, "arms and shoulders 4 days a week");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Build a split from this" }).click();
  await expect(page.getByRole("list", { name: "Proposed split" })).toBeVisible();
  await context.setOffline(false);
});
