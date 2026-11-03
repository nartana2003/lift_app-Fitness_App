import { handleCronJob } from "@/lib/cron/job";
import { runTargetsJob, supabaseTargetStore } from "@/lib/cron/targetsJob";
import { supabaseAdmin } from "@/lib/supabase/server";

// Monthly weekly-target re-check (vercel.json). Needs `Authorization: Bearer
// <CRON_SECRET>`. Stores suggested changes in `target_suggestions` for the
// user to approve; rule-based when there is no AI key. See lib/cron/targetsJob.ts.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  return handleCronJob(req, {
    env: process.env,
    run: (ai) => runTargetsJob(supabaseTargetStore(supabaseAdmin()), ai),
  });
}
