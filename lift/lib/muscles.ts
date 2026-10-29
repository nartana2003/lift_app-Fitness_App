// App muscle groups and how the free-exercise-db muscles map onto them.

export const MUSCLE_GROUPS = [
  "Chest",
  "Back",
  "Lats",
  "Traps",
  "Lower back",
  "Shoulders",
  "Biceps",
  "Triceps",
  "Forearms",
  "Abs/Core",
  "Quads",
  "Hamstrings",
  "Glutes",
  "Hips/Adductors/Abductors",
  "Calves",
  "Neck",
] as const;

export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];


const DB_TO_GROUP: Record<string, MuscleGroup> = {
  chest: "Chest",
  "middle back": "Back",
  lats: "Lats",
  traps: "Traps",
  "lower back": "Lower back",
  shoulders: "Shoulders",
  biceps: "Biceps",
  triceps: "Triceps",
  forearms: "Forearms",
  abdominals: "Abs/Core",
  quadriceps: "Quads",
  hamstrings: "Hamstrings",
  glutes: "Glutes",
  adductors: "Hips/Adductors/Abductors",
  abductors: "Hips/Adductors/Abductors",
  calves: "Calves",
  neck: "Neck",
};

export function mapMuscles(dbMuscles: string[]): MuscleGroup[] {
  const out = new Set<MuscleGroup>();
  for (const m of dbMuscles) {
    const g = DB_TO_GROUP[m.toLowerCase()];
    if (g) out.add(g);
  }
  return [...out];
}

export const EQUIPMENT = [
  "Machine/Cable",
  "Dumbbell",
  "Barbell",
  "Bodyweight",
  "Bands",
  "Kettlebell",
  "Other",
] as const;

export type Equipment = (typeof EQUIPMENT)[number];

export function mapEquipment(dbEquipment: string | null): Equipment {
  switch ((dbEquipment ?? "").toLowerCase()) {
    case "machine":
    case "cable":
      return "Machine/Cable";
    case "dumbbell":
      return "Dumbbell";
    case "barbell":
    case "e-z curl bar":
      return "Barbell";
    case "body only":
    case "":
      return "Bodyweight";
    case "bands":
      return "Bands";
    case "kettlebells":
      return "Kettlebell";
    default:
      return "Other";
  }
}

export function tiktokUrl(name: string): string {
  return `https://www.tiktok.com/search?q=${encodeURIComponent(`${name} exercise form`)}`;
}

/** The TikTok app's own search link (undocumented scheme; callers fall back to tiktokUrl). */
export function tiktokAppSearchUrl(name: string): string {
  return `snssdk1233://search?keyword=${encodeURIComponent(`${name} exercise form`)}`;
}
