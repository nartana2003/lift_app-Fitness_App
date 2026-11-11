import { test, expect } from "@playwright/test";

// Issue #5: completing a set queues the end-of-rest chime on the audio clock.
// The browser cannot be heard here, so AudioContext is replaced by a recorder.
const BENCH = "Barbell_Bench_Press_-_Medium_Grip";

test("completing a set queues the rest-over chime and Skip cancels it", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __notes: { at: number; stopped: boolean }[] };
    w.__notes = [];
    class FakeAudioContext {
      currentTime = 0;
      state = "running";
      destination = {};
      resume() {
        return Promise.resolve();
      }
      createGain() {
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({ connect: () => ({}) }) };
      }
      createOscillator() {
        const note = { at: -1, stopped: false };
        w.__notes.push(note);
        return {
          frequency: { value: 0 },
          connect: () => ({ connect: () => ({}) }),
          start: (t: number) => {
            note.at = t;
          },
          // stop(time) ends the note on schedule; stop() with no time is a cancel.
          stop: (t?: number) => {
            if (t === undefined) note.stopped = true;
          },
        };
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
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
  const notes = () => page.evaluate(() => (window as unknown as { __notes: { at: number; stopped: boolean }[] }).__notes);

  await page.getByRole("button", { name: /^Expand / }).click(); // the card starts collapsed
  await page.getByRole("button", { name: "Complete set" }).click();
  await expect(page.getByText(/Rest ·/)).toBeVisible();
  const queued = await notes();
  // The alarm is the three-note chime repeated four times.
  expect(queued).toHaveLength(12);
  // The default rest is 90 s (or the exercise's own), queued ahead on the audio clock.
  expect(queued[0].at).toBeGreaterThan(10);
  expect(queued.every((n) => !n.stopped)).toBe(true);

  await page.getByRole("button", { name: "Skip" }).click();
  expect((await notes()).slice(0, 12).every((n) => n.stopped)).toBe(true);
});
