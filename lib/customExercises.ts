"use client";

import { db, uuid, type CustomExerciseRow } from "./offline/db";
import { tiktokUrl, type Equipment, type MuscleGroup } from "./muscles";
import { enqueue } from "./offline/sync";

export const isCustomId = (id: string) => id.startsWith("custom-");

export async function createCustomExercise(input: {
  name: string;
  muscle_groups?: MuscleGroup[];
  equipment?: Equipment;
  video_url?: string;
  instructions?: string[];
}): Promise<CustomExerciseRow> {
  const name = input.name.trim();
  const row: CustomExerciseRow = {
    id: `custom-${uuid()}`,
    name,
    muscle_groups: input.muscle_groups ?? [],
    secondary_groups: [],
    equipment: input.equipment ?? "Other",
    category: "strength",
    mechanic: null,
    force: null,
    level: "beginner",
    instructions: input.instructions ?? [],
    image_urls: [],
    tiktok_url: tiktokUrl(name),
    video_url: input.video_url,
    custom: true,
  };
  await db.custom_exercises.put(row);
  const remote: Record<string, unknown> = { ...row };
  delete remote.custom; // local-only marker
  await enqueue([{ table: "exercises", op: "upsert", row: remote }]);
  return row;
}

/** Find an existing custom exercise by name (case-insensitive) or create it. */
export async function ensureCustomExercise(name: string, extra: Omit<Parameters<typeof createCustomExercise>[0], "name"> = {}) {
  const existing = (await db.custom_exercises.toArray()).find((e) => e.name.toLowerCase() === name.trim().toLowerCase());
  return existing ?? createCustomExercise({ name, ...extra });
}

export const deleteCustomExercise = (id: string) => db.custom_exercises.delete(id);
