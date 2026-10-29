import { test, expect, type Page } from "@playwright/test";

// No tab screen may be wider than a phone viewport, even where the page itself
// clips overflow: no element may stick out past the right edge unless it sits
// inside its own horizontal scroller.

const ROUTES = ["/", "/history", "/exercises", "/routines", "/progress", "/profile"];
const WIDTHS = [390, 320];

async function offenders(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scrolls = (el: Element | null) => {
      for (let p = el?.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll") return true;
      }
      return false;
    };
    const bad: string[] = [];
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 1) continue;
      if (getComputedStyle(el).position === "fixed" || scrolls(el)) continue;
      bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(r.right)}`);
    }
    return { vw, scrollWidth: document.documentElement.scrollWidth, bad: bad.slice(0, 5) };
  });
}

for (const width of WIDTHS) {
  for (const route of ROUTES) {
    test(`${route} fits a ${width}px phone`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      const res = await offenders(page);
      expect(res.bad, `scrollWidth ${res.scrollWidth} / viewport ${res.vw}`).toEqual([]);
      expect(res.scrollWidth).toBeLessThanOrEqual(res.vw);
    });
  }
}

test("page clips stray horizontal overflow", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.style.cssText = "width:900px;height:10px";
    document.querySelector("main")!.appendChild(d);
  });
  const { scrollWidth, vw } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    vw: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(vw);
});

for (const width of WIDTHS) {
  test(`progress range picker stays on screen at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/progress");
    const picker = page.locator("select", { has: page.locator("option", { hasText: "3 Months" }) }).first();
    await expect(picker).toBeVisible();
    const box = await picker.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  });
}
