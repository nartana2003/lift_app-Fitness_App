import { test, expect, type Page } from "@playwright/test";

// QA for POOL-02: Today's exercises card. Multi-step, persistence, dialogs, offline.

async function star(page: Page, muscle: string, n: number): Promise<string[]> {
  await page.goto(`/exercises?m=${muscle}`);
  await page.waitForLoadState("networkidle");
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const btn = page.getByRole("button", { name: "Add to favorites" }).first();
    await expect(btn).toBeVisible();
    names.push((await page.locator("li", { has: btn }).first().locator("h3").innerText()).trim());
    await btn.click();
    await expect(page.getByRole("button", { name: "Remove from favorites" })).toHaveCount(i + 1);
  }
  return names;
}

async function openCard(page: Page, preset = "Push / Pull / Legs") {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /Today's exercises/ }).click();
  const use = page.getByRole("button", { name: `Use ${preset}` });
  if (await use.isVisible().catch(() => false)) await use.click();
  await expect(page.getByRole("combobox", { name: "Split day" })).toBeVisible();
}

const errors = (page: Page) => {
  const e: string[] = [];
  page.on("pageerror", (x) => e.push(x.message));
  return e;
};

test("per-muscle count is remembered after reload and limits the picks", async ({ page }) => {
  const errs = errors(page);
  const names = await star(page, "Chest", 3);
  await openCard(page);
  await page.getByRole("button", { name: "3 per muscle" }).click();
  for (const n of names) await expect(page.getByRole("checkbox", { name: n, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "1 per muscle" }).click();
  await expect(page.getByRole("button", { name: "1 per muscle" })).toHaveAttribute("aria-pressed", "true");
  const chest = page.locator("div", { has: page.getByRole("heading", { name: "Chest", exact: true }) }).last();
  await expect(chest.getByRole("checkbox")).toHaveCount(1);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /Today's exercises/ }).click();
  await expect(page.getByRole("button", { name: "1 per muscle" })).toHaveAttribute("aria-pressed", "true");
  expect(errs).toEqual([]);
});

test("rapid taps on per-muscle buttons end in a valid state", async ({ page }) => {
  const errs = errors(page);
  await star(page, "Chest", 2);
  await openCard(page);
  for (const n of [1, 3, 2, 1, 3, 2, 3]) await page.getByRole("button", { name: `${n} per muscle` }).click();
  await expect(page.getByRole("button", { name: "3 per muscle" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "1 per muscle" })).toHaveAttribute("aria-pressed", "false");
  expect(errs).toEqual([]);
});

test("untick all disables Start and Save, retick restores", async ({ page }) => {
  const [a] = await star(page, "Chest", 1);
  await openCard(page);
  const box = page.getByRole("checkbox", { name: a, exact: true });
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect(page.getByRole("button", { name: "Start workout", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save as routine" })).toBeDisabled();
  await box.check();
  await expect(page.getByRole("button", { name: "Start workout", exact: true })).toBeEnabled();
});

test("empty pool muscle shows Star link that opens Exercises for that muscle", async ({ page }) => {
  await star(page, "Chest", 1);
  await openCard(page);
  const link = page.getByRole("link", { name: "Star some exercises for Shoulders to build your pool" });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/exercises\?m=Shoulders/);
});

test("swap picks another pool exercise and the swapped one starts the workout", async ({ page }) => {
  const errs = errors(page);
  const names = await star(page, "Chest", 3);
  await openCard(page);
  await page.getByRole("button", { name: "1 per muscle" }).click();
  const swapBtn = page.getByRole("button", { name: /^Swap / }).first();
  const label = (await swapBtn.getAttribute("aria-label"))!.replace("Swap ", "");
  expect(names).toContain(label);
  await swapBtn.click();
  const alts = page.getByRole("list", { name: "Other Chest exercises" }).getByRole("button");
  await expect(alts).toHaveCount(2);
  const altText = (await alts.first().innerText()).split("\n")[0].trim();
  expect(names).toContain(altText);
  expect(altText).not.toBe(label);
  await alts.first().click();
  await expect(page.getByRole("checkbox", { name: altText, exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: label, exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Start workout", exact: true }).click();
  await expect(page).toHaveURL(/\/workout/);
  await expect(page.getByText(altText).first()).toBeVisible();
  await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  expect(errs).toEqual([]);
});

test("running workout: cancelling the confirm keeps it, accepting replaces it", async ({ page }) => {
  const [a] = await star(page, "Chest", 1);
  await openCard(page);
  await page.getByRole("button", { name: "Start workout", exact: true }).click();
  await expect(page).toHaveURL(/\/workout/);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /Today's exercises/ }).click();
  const msgs: string[] = [];
  page.once("dialog", (d) => {
    msgs.push(d.message());
    void d.dismiss();
  });
  await page.getByRole("button", { name: "Start workout", exact: true }).click();
  await expect.poll(() => msgs.length).toBe(1);
  expect(msgs[0]).toMatch(/in progress/i);
  await expect(page).not.toHaveURL(/\/workout/);
  await expect(page.getByRole("button", { name: "Start workout", exact: true })).toBeEnabled();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Start workout", exact: true }).click();
  await expect(page).toHaveURL(/\/workout/);
  await expect(page.getByText(a).first()).toBeVisible();
});

test("Save as routine saves without starting a workout", async ({ page }) => {
  await star(page, "Chest", 1);
  await openCard(page);
  await page.getByRole("button", { name: "Save as routine" }).click();
  await expect(page.getByRole("status").filter({ hasText: 'Saved as routine "Push"' })).toBeVisible();
  await expect(page).not.toHaveURL(/\/workout/);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Push", { exact: true }).first()).toBeVisible();
});

test("works offline, no horizontal overflow at 390 and 1280, no external requests", async ({ page, context }) => {
  const errs = errors(page);
  await star(page, "Chest", 2);
  const external: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.hostname !== "localhost") external.push(r.url());
  });
  await openCard(page);
  await context.setOffline(true);
  await page.getByRole("button", { name: "3 per muscle" }).click();
  await page.getByRole("combobox", { name: "Split day" }).selectOption({ index: 2 });
  await expect(page.getByRole("heading", { name: "Quads", exact: true })).toBeVisible();
  for (const w of [390, 1280]) {
    await page.setViewportSize({ width: w, height: 900 });
    const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(over).toBe(false);
  }
  await context.setOffline(false);
  expect(external).toEqual([]);
  expect(errs).toEqual([]);
});

test("keyboard: Space toggles a pick checkbox", async ({ page }) => {
  const [a] = await star(page, "Chest", 1);
  await openCard(page);
  const box = page.getByRole("checkbox", { name: a, exact: true });
  await box.focus();
  await page.keyboard.press("Space");
  await expect(box).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(box).toBeChecked();
});
