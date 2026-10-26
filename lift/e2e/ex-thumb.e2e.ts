import { test, expect, type Page } from "@playwright/test";

// Exercises created from a TikTok or Instagram link: the original-video button
// names the platform, the video's thumbnail is the exercise picture, and a
// custom exercise can be deleted. The details route is stubbed for the UI
// flows; the last two tests call the real route.
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TIKTOK = "https://www.tiktok.com/@scout2015/video/6718335390845095173";
const INSTAGRAM = "https://www.instagram.com/reel/Cabc123xyz/";

async function createFromLink(page: Page, name: string, link: string, answer: object) {
  await page.route("**/api/social/import", (route) => route.fulfill({ json: answer }));
  await page.goto("/exercises/new");
  await page.getByPlaceholder("e.g. Lever Hip Abduction").fill(name);
  await page.getByRole("button", { name: "Chest", exact: true }).click();
  await page.getByPlaceholder("TikTok, Instagram or YouTube link").fill(link);
  await page.getByRole("button", { name: "Create exercise" }).click();
  await expect(page).toHaveURL(/\/exercises\/custom-/);
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function deleteIt(page: Page) {
  await page.getByRole("button", { name: "Delete exercise" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/exercises$/);
}

test("tiktok: platform button, thumbnail picture, delete", async ({ page }) => {
  await createFromLink(page, "E2E Tiktok press", TIKTOK, { platform: "tiktok", title: null, thumbnail_url: null, creator: null, cover_data_url: PIXEL });
  const watch = page.getByRole("link", { name: "Watch original TikTok video" });
  await expect(watch).toHaveAttribute("href", TIKTOK);
  await expect(page.getByRole("link", { name: "Watch on TikTok" })).toHaveCount(0);
  await expect(page.locator(`img[alt="E2E Tiktok press"]`)).toHaveAttribute("src", PIXEL);
  await deleteIt(page);
  await expect(page.getByText("E2E Tiktok press")).toHaveCount(0);
});

test("instagram: platform button, thumbnail picture, delete", async ({ page }) => {
  await createFromLink(page, "E2E Insta curl", INSTAGRAM, { platform: "instagram", title: null, thumbnail_url: "https://scontent.cdninstagram.com/t.jpg", creator: null });
  const watch = page.getByRole("link", { name: "Watch original Instagram video" });
  await expect(watch).toHaveAttribute("href", INSTAGRAM);
  await expect(page.getByRole("link", { name: "Watch on TikTok" })).toHaveCount(0);
  await expect(page.locator(`img[alt="E2E Insta curl"]`)).toHaveAttribute("src", "https://scontent.cdninstagram.com/t.jpg");
  await deleteIt(page);
});

test("instagram without a thumbnail still saves and shows the button", async ({ page }) => {
  await createFromLink(page, "E2E Insta plain", INSTAGRAM, { platform: "instagram", manual: true });
  await expect(page.getByRole("link", { name: "Watch original Instagram video" })).toBeVisible();
  await expect(page.locator(`img[alt="E2E Insta plain"]`)).toHaveCount(0);
});

test("a built-in exercise has no delete button", async ({ page }) => {
  await page.goto("/exercises/Crunches");
  await expect(page.getByRole("heading", { name: "Crunches" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete exercise" })).toHaveCount(0);
});

test("real route: tiktok link gives a stored cover image", async ({ request }) => {
  const res = await request.post("/api/social/import", { data: { url: TIKTOK }, timeout: 25_000 });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.platform).toBe("tiktok");
  expect(body.cover_data_url ?? body.thumbnail_url).toMatch(/^(data:image\/(jpeg|png|webp);base64,|https:\/\/)/);
});

test("real route: instagram link answers manual", async ({ request }) => {
  const res = await request.post("/api/social/import", { data: { url: INSTAGRAM } });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ platform: "instagram", manual: true });
});
