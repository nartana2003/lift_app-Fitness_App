import { test, expect } from "@playwright/test";

// A rest has to still alert when the phone locks or another app is in front: notification
// permission is asked at the first rest, silent audio keeps the page alive, and Skip stops it.
// The browser cannot be heard or locked here, so Notification and audio playback are recorders.
const BENCH = "Barbell_Bench_Press_-_Medium_Grip";

test("starting a rest asks for notifications and keeps the page alive with silent audio until Skip", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __asked: number; __plays: { loop: boolean }[]; __pauses: number };
    w.__asked = 0;
    w.__plays = [];
    w.__pauses = 0;
    const fake = function () {} as unknown as { permission: string; requestPermission: () => Promise<string> };
    fake.permission = "default";
    fake.requestPermission = () => {
      w.__asked++;
      return Promise.resolve("granted");
    };
    (window as unknown as { Notification: unknown }).Notification = fake;
    HTMLMediaElement.prototype.play = function () {
      w.__plays.push({ loop: this.loop });
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      w.__pauses++;
    };
  });

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);
  await page.evaluate(async (bench) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = db.transaction(["active"], "readwrite");
    tx.objectStore("active").put({
      key: "active",
      id: "e2e-rest",
      started_at: new Date().toISOString(),
      routine_id: "e2e-rest-routine",
      name: "E2E Rest",
      exercises: [{ id: "e2e-rest-we", exercise_id: bench, sets: [{ id: "s0", reps: 8, weight: 60, is_warmup: false, rir: null, done: false }] }],
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, BENCH);

  await page.goto("/workout");
  await page.waitForLoadState("networkidle");
  const read = () =>
    page.evaluate(() => {
      const w = window as unknown as { __asked: number; __plays: { loop: boolean }[]; __pauses: number };
      return { asked: w.__asked, plays: w.__plays, pauses: w.__pauses };
    });

  await page.getByRole("button", { name: /^Expand / }).click(); // the card starts collapsed
  await page.getByRole("button", { name: "Complete set" }).click();
  await expect(page.getByText(/Rest ·/)).toBeVisible();
  const started = await read();
  expect(started.asked).toBe(1);
  expect(started.plays).toEqual([{ loop: true }]);
  const pausesBefore = started.pauses;

  await page.getByRole("button", { name: "Skip" }).click();
  expect((await read()).pauses).toBeGreaterThan(pausesBefore);
});
