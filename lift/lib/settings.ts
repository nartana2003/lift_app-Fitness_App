"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./offline/db";
import type { Unit } from "./units";
import { normalizeTheme, setThemePref, type ThemePref } from "./theme";

export type Settings = {
  unit: Unit;
  /** 1 = Monday (default), 0 = Sunday */
  weekStart: 0 | 1;
  /** Light (default when unset), dark, or follow the OS. Read via normalizeTheme(). */
  theme?: ThemePref;
};

export const DEFAULT_SETTINGS: Settings = { unit: "kg", weekStart: 1 };

const KEY = "settings";

/** Current settings (defaults until the stored copy loads). */
export function useSettings(): Settings {
  const stored = useLiveQuery(async () => (await db.meta.get(KEY))?.value as Partial<Settings> | undefined, []);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>) {
  await db.transaction("rw", db.meta, async () => {
    const cur = ((await db.meta.get(KEY))?.value as Partial<Settings> | undefined) ?? {};
    await db.meta.put({ key: KEY, value: { ...cur, ...patch } });
  });
}

/** Current theme preference ("light" until one is stored). */
export function useThemePref(): ThemePref {
  return normalizeTheme(useSettings().theme);
}

/** Save the theme preference and apply it to the page straight away. */
export async function saveTheme(theme: ThemePref) {
  setThemePref(theme);
  await saveSettings({ theme });
}
