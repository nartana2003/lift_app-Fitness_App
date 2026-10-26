/**
 * Builds the exercise catalogue from free-exercise-db.
 *   npm run seed            → writes data/exercises.json and upserts into Supabase
 *   npm run seed -- --local → only writes data/exercises.json
 */
import { config as loadEnv } from "dotenv";
import { writeFileSync, mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { mapEquipment, mapMuscles, tiktokUrl } from "../lib/muscles";
import type { Exercise } from "../lib/exercises";
import { EXTRA_EXERCISES } from "../lib/extraExercises";

loadEnv({ path: ".env.local" });

const SRC = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json";
const IMG = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";

type Raw = {
  id: string;
  name: string;
  force: string | null;
  level: string;
  mechanic: string | null;
  equipment: string | null;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  instructions: string[];
  category: string;
  images: string[];
};

async function main() {
  const raw: Raw[] = await (await fetch(SRC)).json();

  const exercises: Exercise[] = raw
    .filter((r) => r.category !== "stretching")
    .map((r) => {
      const primary = mapMuscles(r.primaryMuscles);
      const secondary = mapMuscles(r.secondaryMuscles).filter((m) => !primary.includes(m));
      return {
        id: r.id,
        name: r.name,
        muscle_groups: primary,
        secondary_groups: secondary,
        equipment: mapEquipment(r.equipment),
        category: r.category,
        mechanic: r.mechanic,
        force: r.force,
        level: r.level,
        instructions: r.instructions,
        image_urls: r.images.map((p) => IMG + p),
        tiktok_url: tiktokUrl(r.name),
      };
    })
    .filter((e) => e.muscle_groups.length > 0)
    .concat(EXTRA_EXERCISES)
    .sort((a, b) => a.name.localeCompare(b.name));

  mkdirSync("data", { recursive: true });
  writeFileSync("data/exercises.json", JSON.stringify(exercises));
  writeFileSync("public/exercises.json", JSON.stringify(exercises));
  console.log(`Wrote ${exercises.length} exercises to data/exercises.json`);

  if (process.argv.includes("--local")) return;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("No Supabase credentials in .env.local — skipped database upsert.");
    return;
  }
  const db = createClient(url, key, { auth: { persistSession: false } });
  for (let i = 0; i < exercises.length; i += 200) {
    const { error } = await db.from("exercises").upsert(exercises.slice(i, i + 200));
    if (error) throw error;
  }
  console.log(`Upserted ${exercises.length} exercises into Supabase.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
