"use client";

import { db } from "./offline/db";

const KEY = "renames";

const read = async () => ((await db.meta.get(KEY))?.value as Record<string, string> | undefined) ?? {};

/** Give any exercise (catalogue or custom) your own name. Pass null/"" to go back to the original. */
export async function renameExercise(id: string, name: string | null) {
  await db.transaction("rw", db.meta, async () => {
    const cur = await read();
    const next = { ...cur };
    const clean = name?.trim();
    if (clean) next[id] = clean;
    else delete next[id];
    await db.meta.put({ key: KEY, value: next });
  });
}
