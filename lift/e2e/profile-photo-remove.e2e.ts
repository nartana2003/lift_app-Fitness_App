import { test, expect } from "@playwright/test";

// Profile: a set photo can be removed, which brings back the initial.

test("Remove photo clears the profile picture", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: "Remove photo" })).toHaveCount(0);

  await page.evaluate(
    () =>
      new Promise<void>((res, rej) => {
        const open = indexedDB.open("lift");
        open.onerror = () => rej(open.error);
        open.onsuccess = () => {
          const idb = open.result;
          const tx = idb.transaction("meta", "readwrite");
          tx.objectStore("meta").put({ key: "avatar", value: "data:image/jpeg;base64,AAAA" });
          tx.oncomplete = () => { idb.close(); res(); };
          tx.onerror = () => rej(tx.error);
        };
      }),
  );
  await expect(page.getByAltText("Profile picture")).toBeVisible();
  await page.getByRole("button", { name: "Remove photo" }).click();
  await expect(page.getByAltText("Profile picture")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove photo" })).toHaveCount(0);
});
