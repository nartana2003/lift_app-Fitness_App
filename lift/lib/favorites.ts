"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./offline/db";

const KEY = "favorites";

export function useFavorites(): string[] {
  return useLiveQuery(async () => ((await db.meta.get(KEY))?.value as string[] | undefined) ?? [], [], []);
}

/** Add exercises to the favourites (already-favourite ones are left where they are). */
export async function addFavorites(ids: string[]) {
  await db.transaction("rw", db.meta, async () => {
    const cur = ((await db.meta.get(KEY))?.value as string[] | undefined) ?? [];
    const fresh = ids.filter((id, i) => !cur.includes(id) && ids.indexOf(id) === i);
    if (fresh.length) await db.meta.put({ key: KEY, value: [...fresh, ...cur] });
  });
}

export async function toggleFavorite(id: string) {
  await db.transaction("rw", db.meta, async () => {
    const cur = ((await db.meta.get(KEY))?.value as string[] | undefined) ?? [];
    await db.meta.put({ key: KEY, value: cur.includes(id) ? cur.filter((x) => x !== id) : [id, ...cur] });
  });
}
