import { test, expect, type Page } from "@playwright/test";

// The Home Coach card (CO-08) was removed from Home; the Coach tab still has the Optimise card. All local.

// goalsFingerprint of the default goals with sessionsPerWeek 2 (see lib/goals.ts).
const BUILT_FOR = JSON.stringify(["build_muscle", "intermediate", 2, [], [], []]);

const seed = (page: Page) =>
  page.evaluate(
    (builtFor) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("lift");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(["meta"], "readwrite");
          const meta = tx.objectStore("meta");
          meta.put({ key: "goals", value: { sessionsPerWeek: 4 } });
          meta.put({
            key: "split",
            value: {
              name: "Push pull",
              builtFor,
              days: [
                { id: "push", name: "Push", muscles: ["Chest"] },
                { id: "pull", name: "Pull", muscles: ["Lats", "Biceps"] },
              ],
            },
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    BUILT_FOR,
  );

test("Home has no Coach card, with or without changed goals", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Build or optimise your split/ })).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);
  await seed(page);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
  await expect(page.getByText("Your goals changed")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Optimise for new goals" })).toHaveCount(0);
});
