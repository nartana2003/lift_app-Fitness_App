import { test, expect, type Page } from "@playwright/test";

// REM-01 QA: marked dates drive the Profile next reminder; unmarking restores
// the empty message; persists across reload; usual weekdays still work.

const errors = (page: Page) => {
  const list: string[] = [];
  page.on("pageerror", (e) => list.push(e.message));
  return list;
};

async function openReminders(page: Page) {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Reminders/ }).click();
  await expect(page.getByText("Reminders follow the days you mark on the This Week strip.")).toBeVisible();
}

async function setTime(page: Page, t: string) {
  await openReminders(page);
  await page.getByLabel("Reminder time").fill(t);
  await expect(page.getByLabel("Reminder time")).toHaveValue(t);
}

test("mark, reload, unmark: next reminder appears, persists, then disappears", async ({ page }) => {
  const errs = errors(page);
  await setTime(page, "23:59");
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const first = page.getByRole("button", { name: /not a gym day, tap to mark$/ }).first();
  const day = await first.getAttribute("data-day");
  await first.click();
  await expect(page.locator(`button[data-day="${day}"]`)).toHaveAttribute("aria-pressed", "true");

  await openReminders(page);
  await expect(page.getByText("Next reminder")).toBeVisible();
  await expect(page.getByText("Today 23:59")).toBeVisible();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Reminders/ }).click();
  await expect(page.getByText("Today 23:59")).toBeVisible();

  // Unmark on the strip.
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.locator(`button[data-day="${day}"]`).click();
  const toggle = page.getByRole("button", { name: "Gym day: on" });
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await expect(page.locator(`button[data-day="${day}"]`)).toHaveAttribute("aria-pressed", "false");

  await openReminders(page);
  await expect(page.getByText("Pick at least one gym day to get reminders.")).toBeVisible();
  await expect(page.getByText("Next reminder")).toHaveCount(0);
  expect(errs).toEqual([]);
});

test("usual weekday alone gives a next reminder; the optional-days line is shown; labels unchanged", async ({ page }) => {
  const errs = errors(page);
  await openReminders(page);
  await expect(page.getByText("Optional usual days, reminded every week as well.")).toBeVisible();
  await expect(page.getByText("Gym days", { exact: true })).toBeVisible();
  await expect(page.getByText("Pick at least one gym day to get reminders.")).toBeVisible();
  const group = page.getByRole("group", { name: "Gym days" });
  await group.getByRole("checkbox", { name: "Mon" }).click();
  await expect(group.getByRole("checkbox", { name: "Mon" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Next reminder")).toBeVisible();
  await expect(page.getByText("Pick at least one gym day to get reminders.")).toHaveCount(0);
  await group.getByRole("checkbox", { name: "Mon" }).click();
  await expect(page.getByText("Pick at least one gym day to get reminders.")).toBeVisible();
  expect(errs).toEqual([]);
});

test("marking two dates shows the earlier one; Skip today moves on; works offline at 390px without overflow", async ({ page, context }) => {
  const errs = errors(page);
  await setTime(page, "23:59");
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const buttons = page.getByRole("button", { name: /not a gym day, tap to mark$/ });
  const d1 = await buttons.nth(0).getAttribute("data-day");
  await buttons.nth(0).click();
  await expect(page.locator(`button[data-day="${d1}"]`)).toHaveAttribute("aria-pressed", "true");
  const d2 = await page.getByRole("button", { name: /not a gym day, tap to mark$/ }).first().getAttribute("data-day");
  await page.getByRole("button", { name: /not a gym day, tap to mark$/ }).first().click();
  await expect(page.locator(`button[data-day="${d2}"]`)).toHaveAttribute("aria-pressed", "true");
  expect(d1).not.toBe(d2);

  await context.setOffline(true);
  await page.getByRole("link", { name: /profile/i }).first().click();
  await page.getByRole("button", { name: /^Reminders/ }).click();
  await expect(page.getByText("Today 23:59")).toBeVisible();
  await page.getByRole("button", { name: "Skip today" }).click();
  await expect(page.getByRole("button", { name: "Skip today" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Tomorrow 23:59")).toBeVisible();
  await page.getByRole("button", { name: "Skip today" }).click();
  await expect(page.getByText("Today 23:59")).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await context.setOffline(false);
  expect(errs).toEqual([]);
});

test("wide viewport: reminder block renders with no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openReminders(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});
