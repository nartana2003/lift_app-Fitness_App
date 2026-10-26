import { test, expect } from "@playwright/test";

// LINK-03: a routine linked to today's split day is offered in the Today's
// exercises card as "Use my routine: <name>", next to the pool picks (which stay
// the default). Tapping it starts that routine. Rule-based and local (Dexie);
// no Supabase and no AI key are needed.
test("Today's exercises offers the routine linked to the split day", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /Today's exercises/ }).click();
  await page.getByRole("button", { name: "Use Push / Pull / Legs" }).click();
  await expect(page.getByRole("combobox", { name: "Split day" })).toBeVisible();

  // Link a routine to the first split day (Push), straight in IndexedDB.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("lift");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const split = await new Promise<{ days: { id?: string }[] }>((resolve, reject) => {
      const req = db.transaction("meta").objectStore("meta").get("split");
      req.onsuccess = () => resolve(req.result.value);
      req.onerror = () => reject(req.error);
    });
    const dayId = split.days[0].id;
    if (!dayId) throw new Error("split day has no id");
    const tx = db.transaction(["routines", "routine_exercises"], "readwrite");
    tx.objectStore("routines").put({
      id: "e2e-link03-r",
      name: "E2E Push",
      day_label: null,
      source: "manual",
      kind: "routine",
      source_url: null,
      platform: null,
      thumbnail_url: null,
      creator: null,
      notes: null,
      created_at: new Date().toISOString(),
      split_day_id: dayId,
    });
    tx.objectStore("routine_exercises").put({
      id: "e2e-link03-re",
      routine_id: "e2e-link03-r",
      exercise_id: "Pushups",
      position: 0,
      target_sets: 3,
      target_reps: "10",
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  // Raw IndexedDB writes do not notify Dexie live queries: reload and reopen the card.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /Today's exercises/ }).click();

  const offer = page.getByRole("button", { name: "Use my routine: E2E Push" });
  await expect(offer).toBeVisible();
  // The pool picks stay available.
  await expect(page.getByRole("button", { name: "Start workout", exact: true })).toBeVisible();

  await offer.click();
  await expect(page).toHaveURL(/\/workout/);

  expect(errors).toEqual([]);
});
