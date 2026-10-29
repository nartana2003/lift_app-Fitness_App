// Injury and movement limits chosen as preset chips. A cautious name-keyword filter
// removes exercises that load the sore area. Pure: no I/O, no React, no AI. General
// fitness information, not medical advice.
import type { Exercise } from "./exercises";

export const LIMITATIONS = ["Shoulder", "Knee", "Lower back", "Wrist", "Elbow", "Hip"] as const;
export type Limitation = (typeof LIMITATIONS)[number];

export const LIMITATION_NOTE = "General fitness information, not medical advice. See a professional about pain or injury.";

/** Name patterns of movements that load each area hard. Deliberately cautious. */
const RISKY: Record<Limitation, RegExp> = {
  Shoulder: /overhead|shoulder press|military|upright row|behind (the )?neck|push press|snatch|jerk|handstand|arnold|\bdips?\b/i,
  Knee: /lunge|split squat|pistol|jump|plyo|sissy|hack squat|leg extension|step.?up|burpee|skater|bulgarian/i,
  "Lower back": /deadlift|good morning|bent.?over|hyperextension|back extension|superman|clean|snatch|t-bar|stiff.?leg|sit.?up/i,
  Wrist: /wrist curl|reverse curl|push.?up|handstand|front squat|clean|snatch|burpee|crawl|planche|skull.?crusher/i,
  Elbow: /skull|french press|triceps extension|\bdips?\b|preacher|close.?grip|diamond/i,
  Hip: /sumo|cossack|lunge|split squat|pistol|skater|step.?up|adduct|abduct/i,
};

/** True when no chosen limitation flags this exercise. */
export function allowedFor(exercise: Pick<Exercise, "name" | "original_name">, limitations: readonly Limitation[]): boolean {
  return !limitations.some((l) => RISKY[l]?.test(exercise.name) || (!!exercise.original_name && RISKY[l]?.test(exercise.original_name)));
}

export type LimitationFilter<T> = {
  allowed: T[];
  removed: T[];
  /** The list had exercises but the limits removed every one: tell the user instead of showing nothing. */
  emptied: boolean;
};

/** Splits a list into what is safe to suggest and what was removed. */
export function filterByLimitations<T extends Pick<Exercise, "name" | "original_name">>(
  list: readonly T[],
  limitations: readonly Limitation[],
): LimitationFilter<T> {
  const allowed: T[] = [];
  const removed: T[] = [];
  for (const e of list) (allowedFor(e, limitations) ? allowed : removed).push(e);
  return { allowed, removed, emptied: list.length > 0 && allowed.length === 0 };
}

export const isLimitation = (v: unknown): v is Limitation => typeof v === "string" && (LIMITATIONS as readonly string[]).includes(v);
