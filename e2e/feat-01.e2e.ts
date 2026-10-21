import { test, expect, type Page } from "@playwright/test";
import { EQUIPMENT } from "../lib/muscles";

// FEAT-01: "My gym equipment" checklist on Profile. Runs with no Supabase and
// no AI key (local-only mode); the list is saved on-device in IndexedDB.
// Each test gets a fresh browser context, so it starts as a full gym.

async function openChecklist(page: Page) {
  await page.goto("/profile");
  const toggle = page.getByRole("button", { name: /My gym equipment/ });
  await expect(toggle).toBeVisible();
  await toggle.click();
  const group = page.getByRole("group", { name: "My gym equipment" });
  await expect(group).toBeVisible();
  return group;
}

test("checklist shows every equipment bucket ticked by default", async ({ page }) => {
  const group = await openChecklist(page);
  for (const e of EQUIPMENT) {
    const box = group.getByRole("checkbox", { name: e, exact: true });
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute("aria-checked", "true");
  }
});

test("unticking an item keeps it unticked, also after a reload", async ({ page }) => {
  const group = await openChecklist(page);
  const dumbbell = group.getByRole("checkbox", { name: "Dumbbell", exact: true });
  await dumbbell.click();
  await expect(dumbbell).toHaveAttribute("aria-checked", "false");

  const again = await openChecklist(page);
  await expect(again.getByRole("checkbox", { name: "Dumbbell", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(again.getByRole("checkbox", { name: "Barbell", exact: true })).toHaveAttribute("aria-checked", "true");
});

test("the last ticked item cannot be unticked", async ({ page }) => {
  const group = await openChecklist(page);
  const [keep, ...rest] = EQUIPMENT;
  for (const e of rest) {
    const box = group.getByRole("checkbox", { name: e, exact: true });
    await box.click();
    await expect(box).toHaveAttribute("aria-checked", "false");
  }
  const last = group.getByRole("checkbox", { name: keep, exact: true });
  await expect(page.getByText("Keep at least one ticked.")).toBeVisible();
  // The last item is disabled, so a normal click is refused; force it to prove nothing changes.
  await expect(last).toHaveAttribute("aria-disabled", "true");
  await last.click({ force: true });
  await expect(last).toHaveAttribute("aria-checked", "true");
});
