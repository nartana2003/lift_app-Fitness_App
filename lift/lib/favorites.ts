"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./offline/db";
import { isCatchUpRoutine } from "./catchUp";

const KEY = "favorites";

export function useFavorites(): string[] {
  return useLiveQuery(async () => ((await db.meta.get(KEY))?.value as string[] | undefined) ?? [], [], []);
}

/** Stars first, then every exercise in a routine, without duplicates. Used to pick exercises for the user. */
export function preferredIds(stars: readonly string[], routineExerciseIds: readonly string[]): string[] {
  return [...new Set([...stars, ...routineExerciseIds])];
}

/**
 * The exercises to suggest first: the stars plus everything in the user's own
 * routines (catch-up routines excluded), read live, so routines made earlier or
 * synced from another device count without a backfill. Undefined until loaded.
 */
export function usePreferred(): string[] | undefined {
  return useLiveQuery(
    async () => {
      const stars = ((await db.meta.get(KEY))?.value as string[] | undefined) ?? [];
      const skip = new Set((await db.routines.toArray()).filter((r) => isCatchUpRoutine(r.name)).map((r) => r.id));
      const rows = await db.routine_exercises.toArray();
      return preferredIds(stars, rows.filter((r) => !skip.has(r.routine_id)).map((r) => r.exercise_id));
    },
    [],
  );
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
