"use client";

// A training split: named days, each covering some muscle groups.
import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, uuid } from "./offline/db";
import type { MuscleGroup } from "./muscles";
import { unlinkRoutinesOutside } from "./routines";
import { splitDayIds, splitHasDayIds, withDayIds } from "./splitRoutines";

/**
 * `id` is stable: assigned once when the split is saved (or, for a split stored
 * before ids existed, the first time it is loaded) and kept through renames,
 * reorders and muscle edits. Routines link to it via RoutineRow.split_day_id.
 */
export type SplitDay = { name: string; muscles: MuscleGroup[]; id?: string };
export type Split = { name: string; days: SplitDay[] };

/** Ready-made splits to start from. */
export const PRESETS: Split[] = [
  {
    name: "Push / Pull / Legs",
    days: [
      { name: "Push", muscles: ["Chest", "Shoulders", "Triceps"] },
      { name: "Pull", muscles: ["Back", "Lats", "Biceps", "Traps"] },
      { name: "Legs", muscles: ["Quads", "Hamstrings", "Glutes", "Calves"] },
    ],
  },
  {
    name: "Upper / Lower",
    days: [
      { name: "Upper", muscles: ["Chest", "Back", "Lats", "Shoulders", "Biceps", "Triceps"] },
      { name: "Lower", muscles: ["Quads", "Hamstrings", "Glutes", "Calves", "Abs/Core"] },
    ],
  },
  {
    name: "Full body",
    days: [
      { name: "Full body A", muscles: ["Chest", "Back", "Quads", "Shoulders", "Abs/Core"] },
      { name: "Full body B", muscles: ["Lats", "Hamstrings", "Glutes", "Biceps", "Triceps"] },
    ],
  },
  {
    name: "Arnold (Chest+Back / Shoulders+Arms / Legs)",
    days: [
      { name: "Chest & Back", muscles: ["Chest", "Back", "Lats"] },
      { name: "Shoulders & Arms", muscles: ["Shoulders", "Biceps", "Triceps", "Forearms"] },
      { name: "Legs", muscles: ["Quads", "Hamstrings", "Glutes", "Calves"] },
    ],
  },
];

const KEY = "split";

export const EMPTY_SPLIT: Split = { name: "", days: [] };

export function useSplit(): Split {
  const stored = useLiveQuery(async () => (await db.meta.get(KEY))?.value as Split | undefined, []);
  // A split saved before day ids existed gets them once, written back to the store.
  const legacy = !!stored && Array.isArray(stored.days) && !splitHasDayIds(stored);
  useEffect(() => {
    if (legacy) void ensureSplitDayIds();
  }, [legacy]);
  return stored ?? EMPTY_SPLIT;
}

/**
 * Give the stored split's days ids if any are missing, and write it back.
 * Runs in one transaction, so two callers never assign two different sets of ids.
 * Returns the stored split (undefined when there is none).
 */
export async function ensureSplitDayIds(): Promise<Split | undefined> {
  return db.transaction("rw", db.meta, async () => {
    const stored = (await db.meta.get(KEY))?.value as Split | undefined;
    if (!stored || !Array.isArray(stored.days) || splitHasDayIds(stored)) return stored;
    const next = withDayIds(stored, uuid);
    await db.meta.put({ key: KEY, value: next });
    return next;
  });
}

/**
 * Save the split. Days with no id get one (existing ids are kept). Routines
 * linked to a day that is no longer in the split are unlinked, never deleted.
 */
export async function saveSplit(split: Split): Promise<string> {
  const next = withDayIds(split, uuid);
  const key = await db.meta.put({ key: KEY, value: next });
  await unlinkRoutinesOutside(splitDayIds(next));
  return key;
}

/** Remove the split. Its routines stay, unassigned. */
export async function clearSplit(): Promise<void> {
  await db.meta.delete(KEY);
  await unlinkRoutinesOutside(new Set());
}

/** Muscles in the split that have no day, and days with no muscles. */
export function splitGaps(split: Split, allMuscles: readonly MuscleGroup[]) {
  const covered = new Set(split.days.flatMap((d) => d.muscles));
  return {
    missing: allMuscles.filter((m) => !covered.has(m)),
    emptyDays: split.days.filter((d) => d.muscles.length === 0).map((d) => d.name),
  };
}
