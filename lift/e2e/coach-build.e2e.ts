import { test, expect, type Page } from "@playwright/test";

// CO-05: Build lives on the Coach tab. Priorities, limits and goals are set once in
// "Priorities and limits"; "Build a split" turns them into a split and a draft routine
// for every day, each exercise with a Why and a Replace. There is no AI key in e2e, so
// everything is built from the rules in the browser.

const readAll = (page: Page, store: string) =>
  page.evaluate(
    (name) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const open = indexedDB.open("lift");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction(name).objectStore(name).getAll();
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        };
      }),
    store,
  );

type Meta = { key: string; value: Record<string, unknown> };
const meta = async (page: Page, key: string) => ((await readAll(page, "meta")) as Meta[]).find((m) => m.key === key)?.value;

test("set priorities and limits, build a split with routines, replace one exercise and save", async ({ page }) => {
  await page.goto("/coach");
  await page.waitForLoadState("networkidle");

  // 1) Priorities and limits, saved as you go.
  await page.getByRole("button", { name: /^Priorities and limits/ }).click();
  await page.getByLabel("Goal 1").fill("Bigger arms");
  await page.getByLabel("Goal 1").blur();
  await page.getByRole("region", { name: "Muscle priorities" }).getByLabel("Biceps").selectOption("high");
  await page.getByRole("button", { name: "Knee", exact: true }).click();
  await expect(page.getByRole("button", { name: "Knee", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await meta(page, "goals"))?.limitations).toEqual(["Knee"]);
  await expect.poll(async () => (await meta(page, "goals"))?.priorities).toEqual({ Biceps: "high" });
  expect((await meta(page, "goals"))?.rankedGoals).toEqual(["Bigger arms"]);
  await page.getByRole("button", { name: /^Priorities and limits/ }).click();
  await expect(page.getByRole("button", { name: /^Priorities and limits/ })).toContainText("1 high priority · Knee");

  // 2) Build a split.
  await page.getByRole("button", { name: /^Build a split/ }).click();
  await page.getByRole("button", { name: "Set up with coach" }).click();
  const panel = page.getByRole("region", { name: "Coach setup" });
  const nav = panel.getByRole("group", { name: "Step navigation" });
  await nav.getByRole("button", { name: "Next" }).click();
  await expect(panel.getByRole("heading", { name: "Focus and days" })).toBeVisible();
  await panel.getByLabel("Days a week").fill("3");
  await nav.getByRole("button", { name: "Next" }).click();
  await expect(panel.getByRole("heading", { name: "Your split" })).toBeVisible();
  await panel.getByRole("button", { name: "Build split" }).click();
  await expect(panel.getByRole("list", { name: "Proposed split" })).toBeVisible();
  await panel.getByRole("button", { name: "Use this split" }).click();
  await nav.getByRole("button", { name: "Next" }).click();
  await nav.getByRole("button", { name: "Next" }).click();
  await expect(panel.getByRole("heading", { name: "Review" })).toBeVisible();

  // 3) A draft routine for every day.
  const routines = panel.getByRole("region", { name: "Your routines" });
  await expect(routines).toBeVisible();
  const dayLists = routines.getByRole("list");
  const days = await dayLists.count();
  expect(days).toBe(3);
  await expect(routines.getByRole("checkbox", { name: "Create these routines when I save" })).toBeChecked();

  // Why gives the reason and an honest evidence note.
  const firstWhy = routines.getByRole("button", { name: /^Why / }).first();
  await firstWhy.click();
  await expect(routines.getByText(/exercise for|one of your favourites/).first()).toBeVisible();
  await firstWhy.click();

  // Replace swaps one exercise for another that trains the same muscle.
  const firstName = (await dayLists.first().getByRole("listitem").first().locator(".font-semibold").innerText()).trim();
  await routines.getByRole("button", { name: /^Replace / }).first().click();
  const sheet = page.getByRole("dialog", { name: `Replace ${firstName}` });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/not medical advice/i)).toBeVisible();
  const alt = sheet.getByRole("list", { name: "Alternatives" }).getByRole("button").first();
  await expect(alt).toBeVisible();
  const altName = (await alt.locator(".font-medium").innerText()).trim();
  await alt.click();
  await expect(sheet).toHaveCount(0);
  const names = await dayLists.first().getByRole("listitem").locator(".font-semibold").allInnerTexts();
  expect(names).toContain(altName);
  expect(names).not.toContain(firstName);

  // 4) Save: the split, one routine per day linked to its day, and the goals it was built for.
  await nav.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Coach setup saved.")).toBeVisible();

  const split = (await meta(page, "split")) as { days: { id: string; name: string }[]; builtFor?: string };
  expect(split.days).toHaveLength(3);
  expect(split.builtFor).toBeTruthy();
  const saved = (await readAll(page, "routines")) as { id: string; name: string; split_day_id: string }[];
  expect(saved).toHaveLength(3);
  expect(saved.map((r) => r.split_day_id).sort()).toEqual(split.days.map((d) => d.id).sort());
  const exercises = (await readAll(page, "routine_exercises")) as { routine_id: string; exercise_id: string; target_sets: number; target_reps: string }[];
  expect(exercises.length).toBeGreaterThanOrEqual(3);
  const catalogue = await page.evaluate(async () => (await (await fetch("/exercises.json")).json()) as { id: string; name: string }[]);
  const idOf = (name: string) => catalogue.find((e) => e.name === name)!.id;
  const savedIds = exercises.map((e) => e.exercise_id);
  expect(savedIds).toContain(idOf(altName));
  expect(savedIds).not.toContain(idOf(firstName));
  for (const e of exercises) {
    expect(e.target_sets).toBe(3);
    expect(e.exercise_id).not.toMatch(/lunge|jump|step_up|sissy|hack_squat|bulgarian|split_squat|leg_extension/i);
  }

  // 5) Building again does not make a second set of routines for the same days.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Build a split/ }).click();
  await page.getByRole("button", { name: "Set up with coach" }).click();
  const again = page.getByRole("region", { name: "Coach setup" });
  const againNav = again.getByRole("group", { name: "Step navigation" });
  for (let i = 0; i < 4; i++) await againNav.getByRole("button", { name: "Next" }).click();
  await expect(again.getByRole("heading", { name: "Review" })).toBeVisible();
  await expect(again.getByRole("region", { name: "Your routines" })).toHaveCount(0);
  await againNav.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Coach setup saved.")).toBeVisible();
  expect((await readAll(page, "routines")).length).toBe(3);
});

test("Create unticked saves the split but no routines, and Cancel saves nothing", async ({ page }) => {
  await page.goto("/coach");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Build a split/ }).click();
  await page.getByRole("button", { name: "Set up with coach" }).click();
  const panel = page.getByRole("region", { name: "Coach setup" });
  const nav = panel.getByRole("group", { name: "Step navigation" });
  await nav.getByRole("button", { name: "Next" }).click();
  await nav.getByRole("button", { name: "Next" }).click();
  await panel.getByRole("button", { name: "Build split" }).click();
  await panel.getByRole("button", { name: "Use this split" }).click();
  await nav.getByRole("button", { name: "Next" }).click();
  await nav.getByRole("button", { name: "Next" }).click();
  await panel.getByRole("checkbox", { name: "Create these routines when I save" }).uncheck();

  // Cancel first: nothing is written.
  await panel.getByRole("button", { name: "Cancel" }).click();
  expect(await meta(page, "split")).toBeUndefined();
  expect((await readAll(page, "routines")).length).toBe(0);

  // Then build again and save without routines.
  await page.getByRole("button", { name: "Set up with coach" }).click();
  const p2 = page.getByRole("region", { name: "Coach setup" });
  const n2 = p2.getByRole("group", { name: "Step navigation" });
  await n2.getByRole("button", { name: "Next" }).click();
  await n2.getByRole("button", { name: "Next" }).click();
  await p2.getByRole("button", { name: "Build split" }).click();
  await p2.getByRole("button", { name: "Use this split" }).click();
  await n2.getByRole("button", { name: "Next" }).click();
  await n2.getByRole("button", { name: "Next" }).click();
  await p2.getByRole("checkbox", { name: "Create these routines when I save" }).uncheck();
  await n2.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Coach setup saved.")).toBeVisible();
  expect(((await meta(page, "split")) as { builtFor?: string }).builtFor).toBeTruthy();
  expect((await readAll(page, "routines")).length).toBe(0);
});
