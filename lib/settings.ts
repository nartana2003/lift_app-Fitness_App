"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./offline/db";
import type { Unit } from "./units";

export type Settings = {
  unit: Unit;
  /** 1 = Monday (default), 0 = Sunday */
  weekStart: 0 | 1;
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
