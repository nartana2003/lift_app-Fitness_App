"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./offline/db";

const KEY = "favorites";

export function useFavorites(): string[] {
  return useLiveQuery(async () => ((await db.meta.get(KEY))?.value as string[] | undefined) ?? [], [], []);
}

export async function toggleFavorite(id: string) {
  await db.transaction("rw", db.meta, async () => {
    const cur = ((await db.meta.get(KEY))?.value as string[] | undefined) ?? [];
    await db.meta.put({ key: KEY, value: cur.includes(id) ? cur.filter((x) => x !== id) : [id, ...cur] });
  });
}
