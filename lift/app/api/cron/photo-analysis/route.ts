import { handleCronJob } from "@/lib/cron/job";
import { runPhotoJob, supabasePhotoStore } from "@/lib/cron/photoJob";
import { supabaseAdmin } from "@/lib/supabase/server";

// Monthly photo analysis for the month that just ended (vercel.json). Needs
// `Authorization: Bearer <CRON_SECRET>`. Stores one row per user in
// `photo_analyses`; rule-based when there is no AI key. See lib/cron/photoJob.ts.
export const dynamic = "force-dynamic";
/** Images are decoded with Buffer. */
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  return handleCronJob(req, {
    env: process.env,
    run: (ai) => runPhotoJob(supabasePhotoStore(supabaseAdmin()), ai),
  });
}
