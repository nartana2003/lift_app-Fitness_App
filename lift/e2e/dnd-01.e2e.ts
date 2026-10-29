import { test as base, expect, type Page } from "@playwright/test";

// DND-01: the This Week drag runs on @dnd-kit. Mouse, touch and keyboard drags
// each move or swap a planned day. The clock is fixed to Wednesday 14 Oct 2026
// (week Mon 12 .. Sun 18); data is seeded straight into IndexedDB, no network
// and no AI key.

const WED = "2026-10-14";
const THU = "2026-10-15";
const FRI = "2026-10-16";
const PUSH = { id: "r-push", name: "Push" };
const LEGS = { id: "r-legs", name: "Legs" };

const test = base.extend<{ errors: string[] }>({
  errors: async ({ page }, provide) => {
    const errors: string[] = [];
    // The pinned clock makes server-rendered dates differ from the client's (React #418); ignore that only.
    page.on("pageerror", (e) => {
      if (!/Minified React error #418/.test(String(e))) errors.push(String(e));
    });
    await page.clock.setFixedTime(new Date("2026-10-14T12:00:00"));
    await provide(errors);
    expect(errors, "uncaught page errors").toEqual([]);
  },
});

type Seed = { routines: { id: string; name: string }[]; days: { date: string; routine_id: string }[] };

async function open(page: Page, seed: Seed) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
  await page.evaluate(async (s) => {
    const idb: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise<void>((res, rej) => {
      const tx = idb.transaction(["routines", "routine_exercises", "planned_days"], "readwrite");
      const now = new Date().toISOString();
      s.routines.forEach((r, i) => {
        tx.objectStore("routines").put({
          id: r.id, name: r.name, day_label: null, source: "manual", kind: "routine", source_url: null,
          platform: null, thumbnail_url: null, creator: null, notes: null, created_at: now.replace(/\d\d\.\d+Z$/, `0${i}.000Z`),
        });
        tx.objectStore("routine_exercises").put({
          id: `${r.id}-ex`, routine_id: r.id, exercise_id: "bench", position: 0, target_sets: 3, target_reps: "8-12",
        });
      });
      s.days.forEach((d, i) => {
        tx.objectStore("planned_days").put({
          id: `seed-${i}-${d.date}`, date: d.date, routine_id: d.routine_id, status: "planned",
          workout_id: null, skip_reason: null, skip_note: null, moved_to: null, moved_from: null, created_at: now,
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
  await expect(page.getByText("Drag a planned day to move it.")).toBeVisible();
}

const day = (page: Page, key: string) => page.locator(`button[data-day="${key}"]`);

async function plan(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const idb: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all: { date: string; routine_id: string | null }[] = await new Promise((res, rej) => {
      const q = idb.transaction("planned_days").objectStore("planned_days").getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    idb.close();
    return all.map((r) => `${r.date}:${r.routine_id}`).sort();
  });
}

async function centre(page: Page, key: string) {
  const b = await day(page, key).boundingBox();
  return { x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 };
}

test("mouse: drag a planned day onto a free day moves it", async ({ page, errors }) => {
  void errors;
  await open(page, { routines: [PUSH], days: [{ date: WED, routine_id: PUSH.id }] });
  const a = await centre(page, WED);
  const b = await centre(page, FRI);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await expect(page.getByText(/^Drop to move to /)).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => plan(page)).toEqual([`${FRI}:${PUSH.id}`]);
  await expect(page.getByText(/^Moved Push to /)).toBeVisible();
});

test("mouse: drag a planned day onto another planned day swaps them", async ({ page, errors }) => {
  void errors;
  await open(page, { routines: [PUSH, LEGS], days: [{ date: WED, routine_id: PUSH.id }, { date: FRI, routine_id: LEGS.id }] });
  const a = await centre(page, WED);
  const b = await centre(page, FRI);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  // plan() is sorted, so sort the expectation too: Push on Friday, Legs on Wednesday.
  await expect.poll(() => plan(page)).toEqual([`${FRI}:${PUSH.id}`, `${WED}:${LEGS.id}`].sort());
  await expect(page.getByText(/^Swapped /)).toBeVisible();
});

test("touch: a touch pointer drag moves a planned day", async ({ page, errors }) => {
  void errors;
  await open(page, { routines: [PUSH], days: [{ date: WED, routine_id: PUSH.id }] });
  const a = await centre(page, WED);
  const b = await centre(page, THU);
  const touch = { pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, bubbles: true };
  await day(page, WED).dispatchEvent("pointerdown", { ...touch, clientX: a.x, clientY: a.y });
  for (const f of [0.25, 0.5, 0.75, 1]) {
    await day(page, THU).dispatchEvent("pointermove", { ...touch, clientX: a.x + (b.x - a.x) * f, clientY: a.y });
  }
  await day(page, THU).dispatchEvent("pointerup", { ...touch, clientX: b.x, clientY: b.y });
  await expect.poll(() => plan(page)).toEqual([`${THU}:${PUSH.id}`]);
});

test("keyboard: Space picks up, arrow keys choose, Space drops; Escape cancels", async ({ page, errors }) => {
  void errors;
  await open(page, { routines: [PUSH], days: [{ date: WED, routine_id: PUSH.id }] });
  await day(page, WED).focus();
  await page.keyboard.press("Space");
  await expect(page.getByText("Drop on a free day, or on a planned day to swap")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(page.getByText("Drag a planned day to move it.")).toBeVisible();
  expect(await plan(page)).toEqual([`${WED}:${PUSH.id}`]);

  await day(page, WED).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText(/^Drop to move to /)).toBeVisible();
  await page.keyboard.press("Space");
  await expect.poll(() => plan(page)).toEqual([`${FRI}:${PUSH.id}`]);
});

test("a click on a planned day still opens its panel", async ({ page, errors }) => {
  void errors;
  await open(page, { routines: [PUSH], days: [{ date: WED, routine_id: PUSH.id }] });
  await day(page, WED).click();
  await expect(page.getByText(/^Planned:/)).toBeVisible();
});
