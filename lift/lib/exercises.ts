// Exercise types + pure helpers. Data comes from data/exercises.json (server)
// or /exercises.json (client, see lib/catalogue.ts).
import type { Equipment, MuscleGroup } from "./muscles";

export type Exercise = {
  id: string;
  name: string;
  muscle_groups: MuscleGroup[];
  secondary_groups: MuscleGroup[];
  equipment: Equipment;
  category: string;
  mechanic: string | null;
  force: string | null;
  level: string;
  instructions: string[];
  image_urls: string[];
  tiktok_url: string;
  /** A user-made exercise can link to the video it came from. */
  video_url?: string;
  /** Set when the user renamed it: the catalogue's own name. */
  original_name?: string;
};

/** Applies the user's custom names (id → name) to a list, remembering the original name. */
export function applyRenames(list: Exercise[], renames: Record<string, string>): Exercise[] {
  return list.map((e) => {
    const n = renames[e.id]?.trim();
    return n && n !== e.name ? { ...e, name: n, original_name: e.name } : e;
  });
}

export function searchExercises(
  all: Exercise[],
  opts: { muscle?: string; equipment?: string[]; q?: string },
): Exercise[] {
  const q = opts.q?.trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  return all.filter(
    (e) =>
      (!opts.muscle || e.muscle_groups.includes(opts.muscle as MuscleGroup)) &&
      (!opts.equipment?.length || opts.equipment.includes(e.equipment)) &&
      words.every((w) => e.name.toLowerCase().includes(w) || !!e.original_name?.toLowerCase().includes(w)),
  );
}

export function countByMuscle(all: Exercise[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of all) for (const m of e.muscle_groups) out[m] = (out[m] ?? 0) + 1;
  return out;
}
