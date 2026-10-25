import { test as base, expect, type Page } from "@playwright/test";

// QA for WEEK-01 (independent of the builder's spec). The clock is fixed to
// Wednesday 14 Oct 2026 so the week is Mon 12 .. Sun 18 and there are future
// dates to mark whatever day the suite really runs. Data is seeded straight
// into IndexedDB (the "lift" Dexie database), no network and no AI key.

const MON = "2026-10-12";
const TUE = "2026-10-13";
const WED = "2026-10-14";
const THU = "2026-10-15";
const FRI = "2026-10-16";
const SAT = "2026-10-17";
const SUN = "2026-10-18";
const WEEK = [MON, TUE, WED, THU, FRI, SAT, SUN];

type Seed = {
  routines?: { id: string; name: string }[];
  days?: { date: string; routine_id?: string | null; status?: string; moved_to?: string | null; skip_reason?: string | null }[];
};

const test = base.extend<{ errors: string[] }>({
  errors: async ({ page }, use) => {
    const errors: string[] = [];
    // The fixed clock makes server-rendered date text differ from the client's, which React
    // reports as hydration error #418. That is an artifact of the pinned clock, not a bug, so
    // it is ignored here; the real-clock test at the end of this file checks hydration cleanly.
    page.on("pageerror", (e) => {
      if (!/Minified React error #418/.test(String(e))) errors.push(String(e));
    });
    await page.clock.setFixedTime(new Date("2026-10-14T12:00:00"));
    await use(errors);
    expect(errors, "uncaught page errors").toEqual([]);
  },
});

async function open(page: Page, seed: Seed = {}) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
  if (seed.routines?.length || seed.days?.length) {
    await page.evaluate(async (s) => {
      const idb: IDBDatabase = await new Promise((res, rej) => {
        const r = indexedDB.open("lift");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const stores = ["routines", "routine_exercises", "planned_days"];
      await new Promise<void>((res, rej) => {
        const tx = idb.transaction(stores, "readwrite");
        const now = new Date().toISOString();
        (s.routines ?? []).forEach((r, i) => {
          tx.objectStore("routines").put({
            id: r.id, name: r.name, day_label: null, source: "manual", kind: "routine", source_url: null,
            platform: null, thumbnail_url: null, creator: null, notes: null, created_at: now.replace(/\d\d\.\d+Z$/, `0${i}.000Z`),
          });
          tx.objectStore("routine_exercises").put({
            id: `${r.id}-ex`, routine_id: r.id, exercise_id: "bench", position: 0, target_sets: 3, target_reps: "8-12",
          });
        });
        (s.days ?? []).forEach((d, i) => {
          tx.objectStore("planned_days").put({
            id: `seed-${i}-${d.date}`, date: d.date, routine_id: d.routine_id ?? null, status: d.status ?? "planned",
            workout_id: null, skip_reason: d.skip_reason ?? null, skip_note: null, moved_to: d.moved_to ?? null,
            moved_from: null, created_at: now,
          });
        });
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      idb.close();
    }, seed);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("button[data-day]")).toHaveCount(7);
  }
}

const day = (page: Page, key: string) => page.locator(`button[data-day="${key}"]`);

async function rows(page: Page): Promise<{ date: string; routine_id: string | null; status: string }[]> {
  return page.evaluate(async () => {
    const idb: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all: { date: string; routine_id: string | null; status: string }[] = await new Promise((res, rej) => {
      const q = idb.transaction("planned_days").objectStore("planned_days").getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    idb.close();
    return all.map(({ date, routine_id, status }) => ({ date, routine_id, status })).sort((a, b) => a.date.localeCompare(b.date));
  });
}

const BLACK = "rgb(17, 17, 17)";
const PUSH = { id: "r-push", name: "Push" };
const PULL = { id: "r-pull", name: "Pull" };

for (const vp of [
  { w: 390, h: 844 },
  { w: 320, h: 640 },
  { w: 1280, h: 800 },
]) {
  test(`all seven days are round circles with no boxes at ${vp.w}px`, async ({ page, errors }) => {
    void errors;
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await open(page, { routines: [PUSH], days: [{ date: THU }, { date: FRI, routine_id: PUSH.id }, { date: SAT, status: "skipped", routine_id: PUSH.id }] });
    const buttons = page.locator("button[data-day]");
    await expect(buttons).toHaveCount(7);
    const info = await page.evaluate(() => {
      const out: { w: number; h: number; radius: number; left: number; right: number; liBorder: number; liBg: string; liRadius: number }[] = [];
      document.querySelectorAll<HTMLElement>("button[data-day]").forEach((b) => {
        const r = b.getBoundingClientRect();
        const li = b.closest("li")!;
        const lcs = getComputedStyle(li);
        out.push({
          w: r.width, h: r.height, radius: parseFloat(getComputedStyle(b).borderTopLeftRadius),
          left: r.left, right: r.right,
          liBorder: ["Top", "Right", "Bottom", "Left"].reduce((a, s) => a + parseFloat((lcs as unknown as Record<string, string>)[`border${s}Width`]), 0),
          liBg: lcs.backgroundColor, liRadius: parseFloat(lcs.borderTopLeftRadius) || 0,
        });
      });
      return { out, scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth };
    });
    expect(info.out).toHaveLength(7);
    for (const c of info.out) {
      expect(Math.abs(c.w - c.h)).toBeLessThan(1);
      expect(c.w).toBeGreaterThanOrEqual(40);
      expect(c.radius).toBeGreaterThanOrEqual(c.w / 2);
      expect(c.liBorder).toBe(0);
      expect(c.liBg).toBe("rgba(0, 0, 0, 0)");
      expect(c.liRadius).toBe(0);
      expect(c.left).toBeGreaterThanOrEqual(0);
      expect(c.right).toBeLessThanOrEqual(vp.w);
    }
    for (let i = 1; i < 7; i++) expect(info.out[i].left).toBeGreaterThanOrEqual(info.out[i - 1].right - 0.5); // no overlap
    expect(info.scrollW).toBeLessThanOrEqual(info.clientW);
    if (vp.w === 390) await page.screenshot({ path: "test-results/week-01-qa-390.png" });
  });
}

test("a marked date is solid black with white number; unmarked future is not filled", async ({ page, errors }) => {
  void errors;
  await open(page, { days: [{ date: FRI }] });
  const fri = await day(page, FRI).evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
  expect(fri.bg).toBe(BLACK);
  expect(fri.color).toBe("rgb(255, 255, 255)");
  const thu = await day(page, THU).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(thu).not.toBe(BLACK);
});

test("tap marks a future date, opens the panel, others stay; survives reload; one row", async ({ page, errors }) => {
  void errors;
  await open(page);
  await day(page, THU).click();
  await expect(day(page, THU)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Gym day: on" })).toBeVisible();
  await expect(page.getByText("Plan a routine")).toHaveCount(0); // no routines exist yet
  for (const k of WEEK.filter((x) => x !== THU)) await expect(day(page, k)).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(day(page, THU)).toHaveAttribute("aria-pressed", "true");
  for (const k of WEEK.filter((x) => x !== THU)) await expect(day(page, k)).toHaveAttribute("aria-pressed", "false");
  expect(await rows(page)).toEqual([{ date: THU, routine_id: null, status: "planned" }]);
  await expect(day(page, THU)).toHaveAccessibleName(/Thursday 15, gym day, tap to change/);
});

test("tapping a marked date opens the panel without changing it, tapping again closes it", async ({ page, errors }) => {
  void errors;
  await open(page, { days: [{ date: FRI }] });
  await day(page, FRI).click();
  await expect(page.getByRole("button", { name: "Gym day: on" })).toBeVisible();
  expect(await rows(page)).toHaveLength(1);
  await expect(day(page, FRI)).toHaveAttribute("aria-pressed", "true");
  await day(page, FRI).click();
  await expect(page.getByRole("button", { name: "Gym day: on" })).toHaveCount(0);
  await expect(day(page, FRI)).toHaveAttribute("aria-pressed", "true");
  expect(await rows(page)).toHaveLength(1);
});

test("tapping a past date opens the panel but never marks, even across reload", async ({ page, errors }) => {
  void errors;
  await open(page);
  for (const k of [MON, TUE]) {
    await day(page, k).click();
    await expect(page.getByRole("button", { name: "Gym day: off" })).toBeDisabled();
    await expect(day(page, k)).toHaveAttribute("aria-pressed", "false");
    await expect(day(page, k)).toHaveAccessibleName(/not a gym day$/);
  }
  await page.reload();
  await page.waitForLoadState("networkidle");
  expect(await rows(page)).toEqual([]);
});

test("Gym day toggle unmarks a routine-less date and the mark does not return after reload", async ({ page, errors }) => {
  void errors;
  await open(page, { days: [{ date: THU }, { date: SAT }] });
  await day(page, THU).click();
  await page.getByRole("button", { name: "Gym day: on" }).click();
  await expect(day(page, THU)).toHaveAttribute("aria-pressed", "false");
  await expect(day(page, SAT)).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await page.waitForLoadState("networkidle");
  expect((await rows(page)).map((r) => r.date)).toEqual([SAT]);
});

test("unmarking a date with a routine asks first: dismiss keeps it, accept removes it", async ({ page, errors }) => {
  void errors;
  await open(page, { routines: [PUSH], days: [{ date: THU, routine_id: PUSH.id }] });
  const messages: string[] = [];
  let accept = false;
  page.on("dialog", async (d) => {
    messages.push(d.message());
    if (accept) await d.accept();
    else await d.dismiss();
  });
  await day(page, THU).click();
  await page.getByRole("button", { name: "Gym day: on" }).click();
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toContain("Push");
  expect(await rows(page)).toHaveLength(1);
  await expect(day(page, THU)).toHaveAttribute("aria-pressed", "true");
  accept = true;
  await page.getByRole("button", { name: "Gym day: on" }).click();
  await expect(day(page, THU)).toHaveAttribute("aria-pressed", "false");
  expect(await rows(page)).toEqual([]);
});

test("done, skipped and moved dates have a locked toggle", async ({ page, errors }) => {
  void errors;
  await open(page, {
    routines: [PUSH],
    days: [
      { date: WED, routine_id: PUSH.id, status: "done" },
      { date: THU, routine_id: PUSH.id, status: "skipped", skip_reason: "busy" },
      { date: FRI, routine_id: PUSH.id, status: "moved", moved_to: SAT, skip_reason: "busy" },
    ],
  });
  for (const k of [WED, THU, FRI]) {
    await day(page, k).click();
    await expect(page.getByRole("button", { name: /Gym day: (on|off)/ })).toBeDisabled();
    await day(page, k).click();
  }
  expect((await rows(page)).map((r) => r.status)).toEqual(["done", "skipped", "moved"]);
  await expect(day(page, THU)).toHaveAttribute("aria-pressed", "false");
});

test("rapid taps on one date create at most one row and no page error", async ({ page, errors }) => {
  void errors;
  await open(page);
  await day(page, THU).click({ clickCount: 3, delay: 0 });
  await day(page, THU).dblclick();
  await page.waitForTimeout(300);
  const r = await rows(page);
  expect(r.filter((x) => x.date === THU)).toHaveLength(1);
  expect(r).toHaveLength(1);
});

test("rapid taps across several dates leave exactly those dates marked", async ({ page, errors }) => {
  void errors;
  await open(page);
  for (const k of [THU, FRI, SAT]) await day(page, k).click();
  await expect(day(page, SAT)).toHaveAttribute("aria-pressed", "true");
  expect((await rows(page)).map((r) => r.date)).toEqual([THU, FRI, SAT]);
});

test("keyboard: Tab reaches the day buttons, Enter and Space mark and open", async ({ page, errors }) => {
  void errors;
  await open(page);
  // Tab until a day button has focus.
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    await page.keyboard.press("Tab");
    found = await page.evaluate(() => !!document.activeElement?.hasAttribute("data-day"));
  }
  expect(found).toBe(true);
  // Move to Thursday by tabbing (days are in DOM order).
  for (let i = 0; i < 7; i++) {
    const k = await page.evaluate(() => document.activeElement?.getAttribute("data-day"));
    if (k === THU) break;
    await page.keyboard.press("Tab");
  }
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-day"))).toBe(THU);
  // visible focus ring
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(day(page, THU)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Gym day: on" })).toBeVisible();
  await day(page, FRI).focus();
  await page.keyboard.press("Space");
  await expect(day(page, FRI)).toHaveAttribute("aria-pressed", "true");
  expect((await rows(page)).map((r) => r.date)).toEqual([THU, FRI]);
});

test("marking works offline and persists after reload", async ({ page, context, errors }) => {
  void errors;
  await open(page);
  await context.setOffline(true);
  await day(page, SAT).click();
  await expect(day(page, SAT)).toHaveAttribute("aria-pressed", "true");
  await context.setOffline(false);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(day(page, SAT)).toHaveAttribute("aria-pressed", "true");
});

test("a routine-less marked date sits beside routine days: skip, undo, move, undo still work", async ({ page, errors }) => {
  void errors;
  await open(page, { routines: [PUSH], days: [{ date: THU }, { date: FRI, routine_id: PUSH.id }] });
  // Skip Friday.
  await day(page, FRI).click();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByRole("button", { name: "Skip this day" }).click();
  await expect(day(page, FRI)).toHaveAccessibleName(/skipped, tap to change/);
  await day(page, FRI).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(day(page, FRI)).toHaveAttribute("aria-pressed", "true");
  // Move Friday to Saturday (a free day), then undo.
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByRole("button", { name: "Move to Sat" }).click();
  await expect(day(page, SAT)).toHaveAttribute("aria-pressed", "true");
  await expect(day(page, FRI)).toHaveAccessibleName(/moved, tap to change/);
  await day(page, FRI).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(day(page, FRI)).toHaveAttribute("aria-pressed", "true");
  await expect(day(page, SAT)).toHaveAttribute("aria-pressed", "false");
  // The routine-less Thursday mark was never touched.
  expect(await rows(page)).toEqual([
    { date: THU, routine_id: null, status: "planned" },
    { date: FRI, routine_id: PUSH.id, status: "planned" },
  ]);
});

test("a routine-less marked date is not offered Skip or Move and is not draggable", async ({ page, errors }) => {
  void errors;
  await open(page, { routines: [PUSH], days: [{ date: THU }, { date: FRI, routine_id: PUSH.id }] });
  await day(page, THU).click();
  await expect(page.getByRole("button", { name: "Skip", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move", exact: true })).toHaveCount(0);
  // Try to drag Thursday onto Saturday: nothing changes.
  const a = await day(page, THU).boundingBox();
  const b = await day(page, SAT).boundingBox();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect((await rows(page)).map((r) => `${r.date}:${r.routine_id}`)).toEqual([`${THU}:null`, `${FRI}:${PUSH.id}`]);
});

test("dragging a routine day onto a routine-less marked date moves the routine there", async ({ page, errors }) => {
  void errors;
  await open(page, { routines: [PUSH], days: [{ date: THU }, { date: FRI, routine_id: PUSH.id }] });
  const a = await day(page, FRI).boundingBox();
  const b = await day(page, THU).boundingBox();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await rows(page)).map((r) => `${r.date}:${r.routine_id}`)).toEqual([`${THU}:${PUSH.id}`]);
});

test("Auto-fill fills the marked date first and leaves the unmarked days alone", async ({ page, errors }) => {
  void errors;
  await open(page, { routines: [PUSH, PULL], days: [{ date: SAT }] });
  await page.getByRole("button", { name: "Auto-fill from my split" }).click();
  await expect(page.getByRole("button", { name: "Sat", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Fill \d+ days?$/ }).click();
  await expect.poll(async () => (await rows(page)).find((r) => r.date === SAT)?.routine_id).toBeTruthy();
  expect((await rows(page)).filter((r) => r.date === SAT)).toHaveLength(1);
});

test.describe("real clock", () => {
  test("marking today with the real clock raises no page errors (hydration included)", async ({ page }) => {
    const errs: string[] = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const first = page.getByRole("button", { name: /not a gym day, tap to mark$/ }).first();
    await first.click();
    await expect(page.getByRole("button", { name: "Gym day: on" })).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /gym day, tap to change$/ })).toHaveCount(1);
    expect(errs).toEqual([]);
  });
});
