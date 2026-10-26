// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../offline/db";
import { DEFAULT_SETTINGS, saveTheme, type Settings } from "../settings";
import {
  applyTheme,
  DEFAULT_THEME,
  isThemePref,
  normalizeTheme,
  resolveTheme,
  THEME_COLORS,
  THEME_STORAGE_KEY,
  themeInitScript,
} from "../theme";

/** Fake matchMedia whose "dark" answer can be flipped, firing change listeners. */
function fakeMatchMedia(dark: boolean) {
  const listeners: (() => void)[] = [];
  const mq = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, f: () => void) => listeners.push(f),
  };
  window.matchMedia = vi.fn(() => mq) as unknown as typeof window.matchMedia;
  return {
    setDark(v: boolean) {
      dark = v;
      listeners.forEach((f) => f());
    },
  };
}

const runInit = () => new Function(themeInitScript)();
const html = () => document.documentElement;

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  html().removeAttribute("data-theme");
  html().style.colorScheme = "";
  document.head.innerHTML = '<meta name="theme-color" content="#ffffff">';
  fakeMatchMedia(false);
});

afterEach(() => vi.restoreAllMocks());

describe("resolveTheme", () => {
  it("defaults to light", () => {
    expect(DEFAULT_THEME).toBe("light");
    expect(resolveTheme(undefined, true)).toBe("light");
  });

  it("uses explicit light and dark regardless of the OS", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the OS for system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("treats unknown values as light", () => {
    expect(resolveTheme("purple", true)).toBe("light");
    expect(normalizeTheme(null)).toBe("light");
    expect(isThemePref("dark")).toBe(true);
    expect(isThemePref("Dark")).toBe(false);
  });
});

describe("applyTheme", () => {
  it("sets data-theme, color-scheme and the browser theme colour", () => {
    applyTheme(document, "dark");
    expect(html().dataset.theme).toBe("dark");
    expect(html().style.colorScheme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", THEME_COLORS.dark);
    applyTheme(document, "light");
    expect(html().dataset.theme).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#ffffff");
  });

  it("keeps light exactly white", () => {
    expect(THEME_COLORS.light).toBe("#ffffff");
  });
});

describe("themeInitScript (pre-paint)", () => {
  it("applies light when nothing is stored", () => {
    runInit();
    expect(html().dataset.theme).toBe("light");
  });

  it("applies the stored dark preference", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    runInit();
    expect(html().dataset.theme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", THEME_COLORS.dark);
  });

  it("follows OS changes while the preference is system", () => {
    const os = fakeMatchMedia(true);
    localStorage.setItem(THEME_STORAGE_KEY, "system");
    runInit();
    expect(html().dataset.theme).toBe("dark");
    os.setDark(false);
    expect(html().dataset.theme).toBe("light");
  });

  it("ignores OS changes when an explicit theme is chosen", () => {
    const os = fakeMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    runInit();
    os.setDark(true);
    expect(html().dataset.theme).toBe("light");
  });

  it("does not throw without matchMedia", () => {
    // @ts-expect-error simulate an old browser
    window.matchMedia = undefined;
    localStorage.setItem(THEME_STORAGE_KEY, "system");
    expect(runInit).not.toThrow();
    expect(html().dataset.theme).toBe("light");
  });
});

describe("saveTheme", () => {
  const stored = async () => (await db.meta.get("settings"))?.value as Partial<Settings> | undefined;

  it("persists via settings, mirrors to localStorage and applies now", async () => {
    await saveTheme("dark");
    expect(await stored()).toEqual({ theme: "dark" });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(html().dataset.theme).toBe("dark");
  });

  it("keeps other settings when the theme changes", async () => {
    await db.meta.put({ key: "settings", value: { unit: "lb" } });
    await saveTheme("system");
    expect(await stored()).toEqual({ unit: "lb", theme: "system" });
  });

  it("does not add theme to the default settings object", () => {
    expect(DEFAULT_SETTINGS).toEqual({ unit: "kg", weekStart: 1 });
  });
});
