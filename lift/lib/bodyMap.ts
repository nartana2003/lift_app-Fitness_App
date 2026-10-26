// Maps our muscle groups onto react-body-highlighter's muscles + which side of the body they show on.
import type { IExerciseData, Muscle } from "react-body-highlighter";
import type { MuscleGroup } from "./muscles";

export type BodyView = "anterior" | "posterior";

export const GROUP_MAP: Record<MuscleGroup, { view: BodyView; muscles: Muscle[] }> = {
  Chest: { view: "anterior", muscles: ["chest"] },
  Back: { view: "posterior", muscles: ["upper-back"] },
  Lats: { view: "posterior", muscles: ["upper-back"] },
  Traps: { view: "posterior", muscles: ["trapezius"] },
  "Lower back": { view: "posterior", muscles: ["lower-back"] },
  Shoulders: { view: "anterior", muscles: ["front-deltoids", "back-deltoids"] },
  Biceps: { view: "anterior", muscles: ["biceps"] },
  Triceps: { view: "posterior", muscles: ["triceps"] },
  Forearms: { view: "anterior", muscles: ["forearm"] },
  "Abs/Core": { view: "anterior", muscles: ["abs", "obliques"] },
  Quads: { view: "anterior", muscles: ["quadriceps"] },
  Hamstrings: { view: "posterior", muscles: ["hamstring"] },
  Glutes: { view: "posterior", muscles: ["gluteal"] },
  "Hips/Adductors/Abductors": { view: "anterior", muscles: ["adductor", "abductors"] },
  Calves: { view: "posterior", muscles: ["calves"] },
  Neck: { view: "anterior", muscles: ["neck"] },
};

/** Light → dark shades; the library picks `colors[frequency - 1]`. */
export const INTENSITY_COLORS = ["#9ca3af", "#6b7280", "#374151", "#111111"];

/** 1–4 shade for a number of sets (0 = not worked). */
export function intensityLevel(sets: number): number {
  return sets <= 0 ? 0 : sets < 4 ? 1 : sets < 8 ? 2 : sets < 12 ? 3 : 4;
}

/**
 * Library data for a set of muscle groups. Frequency (= shade) is expressed by repeating a
 * muscle `level` times, which is how the library counts it.
 */
export function bodyMapData(setsByGroup: Record<string, number>, view: BodyView): IExerciseData[] {
  const out: IExerciseData[] = [];
  for (const [group, sets] of Object.entries(setsByGroup)) {
    const map = GROUP_MAP[group as MuscleGroup];
    const level = intensityLevel(sets);
    if (!map || level === 0 || map.view !== view) continue;
    for (let i = 0; i < level; i++) out.push({ name: `${group}-${i}`, muscles: map.muscles });
  }
  return out;
}
