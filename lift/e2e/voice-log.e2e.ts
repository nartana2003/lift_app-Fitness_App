import { test, expect, type Page } from "@playwright/test";

// Quick log voice: a stubbed SpeechRecognition stands in for the microphone, so the
// real page, button and text box are driven in the browser. Parsing needs the AI
// key, which is blank here, so the flow ends at the "not available" message.

const STUB = () => {
  class Fake {
    lang = "";
    continuous = false;
    interimResults = false;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start() {
      (window as unknown as { __rec: Fake }).__rec = this;
    }
    stop() {
      this.onend?.();
    }
  }
  (window as unknown as { SpeechRecognition: typeof Fake }).SpeechRecognition = Fake;
};

async function openQuickLog(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Start Workout" }).click();
  await expect(page).toHaveURL(/\/workout/);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Quick log" }).click();
}

test("speaking fills the Quick log text box", async ({ page }) => {
  await page.addInitScript(STUB);
  await openQuickLog(page);
  await page.getByRole("button", { name: "Speak" }).click();
  await expect(page.getByRole("button", { name: /Listening/ })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __rec: { onresult: (e: unknown) => void } }).__rec.onresult({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "bench press 3x8 at 60" } }],
    }),
  );
  await expect(page.getByLabel("Quick log text")).toHaveValue("bench press 3x8 at 60");
  await page.getByRole("button", { name: /Listening/ }).click();
  await expect(page.getByRole("button", { name: "Speak" })).toBeVisible();
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("Quick log is not available right now. You can still add exercises by hand.")).toBeVisible();
});

test("a blocked microphone shows a plain message", async ({ page }) => {
  await page.addInitScript(STUB);
  await openQuickLog(page);
  await page.getByRole("button", { name: "Speak" }).click();
  await page.evaluate(() =>
    (window as unknown as { __rec: { onerror: (e: { error: string }) => void } }).__rec.onerror({ error: "not-allowed" }),
  );
  await expect(page.getByText(/Microphone access is blocked/)).toBeVisible();
});

test("no mic button when the browser has no speech recognition", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  });
  await openQuickLog(page);
  await expect(page.getByLabel("Quick log text")).toBeVisible();
  await expect(page.getByRole("button", { name: /Speak|Listening/ })).toHaveCount(0);
});
