import { test, expect, type Page } from "@playwright/test";

// CO-08: the Home Coach card. With no split it links to /coach. When the split was
// built for goals that have since changed, it says what the split was built for and
// "Optimise for new goals" opens /coach with the Optimise card expanded. All local.

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

test("Home Coach card links to /coach by default", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const card = page.getByRole("link", { name: /Build or optimise your split/ });
  await expect(card).toBeVisible();
  await expect(page.getByText("Your goals changed")).toHaveCount(0);
  await card.click();
  await expect(page).toHaveURL(/\/coach$/);
  await expect(page.getByRole("heading", { name: "Coach" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Optimise/ })).toHaveAttribute("aria-expanded", "false");
});

test("goals changed: Home nudges and opens Coach with Optimise expanded", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "lift")))
    .toBe(true);
  await seed(page);
  await page.reload();
  await page.waitForLoadState("networkidle");

  await expect(page.getByText("Your goals changed")).toBeVisible();
  await expect(page.getByText("Your split was built for Build muscle · Intermediate · 2×/week.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Build or optimise your split/ })).toHaveCount(0);
  // The rest of Home is still there.
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();

  await page.getByRole("link", { name: "Optimise for new goals" }).click();
  await expect(page).toHaveURL(/\/coach\?open=optimise$/);
  await expect(page.getByRole("button", { name: "Optimise", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Optimise my split" })).toBeVisible();
});
