"use client";

// A training split: named days, each covering some muscle groups.
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./offline/db";
import type { MuscleGroup } from "./muscles";

export type SplitDay = { name: string; muscles: MuscleGroup[] };
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
  return stored ?? EMPTY_SPLIT;
}

export const saveSplit = (split: Split) => db.meta.put({ key: KEY, value: split });
export const clearSplit = () => db.meta.delete(KEY);

/** Muscles in the split that have no day, and days with no muscles. */
export function splitGaps(split: Split, allMuscles: readonly MuscleGroup[]) {
  const covered = new Set(split.days.flatMap((d) => d.muscles));
  return {
    missing: allMuscles.filter((m) => !covered.has(m)),
    emptyDays: split.days.filter((d) => d.muscles.length === 0).map((d) => d.name),
  };
}
