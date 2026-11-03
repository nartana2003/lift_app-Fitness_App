import catalogueJson from "@/data/exercises.json";
import type { Exercise } from "@/lib/exercises";
import { handleCronJob } from "@/lib/cron/job";
import { runPlateauJob, supabasePlateauStore } from "@/lib/cron/plateauJob";
import { supabaseAdmin } from "@/lib/supabase/server";

// Weekly plateau check (vercel.json). Needs `Authorization: Bearer <CRON_SECRET>`.
// Stores one fix per stalled lift in `plateaus`; rule-based when there is no
// AI key. See lib/cron/plateauJob.ts.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const catalogue = catalogueJson as unknown as Exercise[];

export async function GET(req: Request) {
  return handleCronJob(req, {
    env: process.env,
    run: (ai) => runPlateauJob(supabasePlateauStore(supabaseAdmin()), ai, catalogue),
  });
}
