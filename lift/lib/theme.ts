/**
 * Light / dark / system theme. Pure helpers plus a tiny inline script for the
 * root layout so the right theme is on <html> before first paint (no flash).
 *
 * The preference itself lives in settings (Dexie). It is mirrored to
 * localStorage only so the pre-paint script can read it synchronously.
 */

export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_PREFS: readonly ThemePref[] = ["light", "dark", "system"];
export const DEFAULT_THEME: ThemePref = "light";
export const THEME_LABELS: Record<ThemePref, string> = { light: "Light", dark: "Dark", system: "System" };

/** localStorage key mirrored from settings for the pre-paint script. */
export const THEME_STORAGE_KEY = "lift-theme";

/** Browser chrome colour (meta theme-color) per resolved theme. Matches --bg in globals.css. */
export const THEME_COLORS: Record<ResolvedTheme, string> = { light: "#ffffff", dark: "#0a0a0a" };

export function isThemePref(v: unknown): v is ThemePref {
  return v === "light" || v === "dark" || v === "system";
}

/** Anything unknown or missing falls back to the default (light). */
export function normalizeTheme(v: unknown): ThemePref {
  return isThemePref(v) ? v : DEFAULT_THEME;
}

/** The theme actually shown, given the preference and whether the OS prefers dark. */
export function resolveTheme(pref: unknown, systemPrefersDark: boolean): ResolvedTheme {
  const p = normalizeTheme(pref);
  if (p === "system") return systemPrefersDark ? "dark" : "light";
  return p;
}

/** Puts the resolved theme on <html>: data-theme, color-scheme and meta theme-color. */
export function applyTheme(doc: Document, theme: ResolvedTheme) {
  const root = doc.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
}

function systemDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

/** Client only: mirror the preference for the pre-paint script and apply it now. */
export function setThemePref(pref: ThemePref) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {}
  applyTheme(document, resolveTheme(pref, systemDark()));
}

/**
 * Inline <script> body for the root layout. Runs before paint, applies the
 * stored preference, and follows OS changes while the preference is "system".
 * Self-contained (no imports at runtime), so it is written out as a string.
 */
export const themeInitScript = `(function(){try{
var K=${JSON.stringify(THEME_STORAGE_KEY)},C=${JSON.stringify(THEME_COLORS)};
var mq=window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)"):null;
function pref(){var p=null;try{p=localStorage.getItem(K)}catch(e){}return p==="dark"||p==="system"?p:"light"}
function apply(){var p=pref(),t=p==="system"?(mq&&mq.matches?"dark":"light"):p,r=document.documentElement;
r.setAttribute("data-theme",t);r.style.colorScheme=t;
var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",C[t]);}
apply();
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",apply);
if(mq){var f=function(){if(pref()==="system")apply()};if(mq.addEventListener)mq.addEventListener("change",f);else if(mq.addListener)mq.addListener(f);}
window.addEventListener("storage",function(e){if(e.key===K)apply()});
}catch(e){}})();`;
