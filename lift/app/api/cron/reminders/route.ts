import { handleReminderCron, supabaseReminderStore } from "@/lib/push/reminderJob";
import { getPushSender } from "@/lib/push/send";
import { supabaseAdmin } from "@/lib/supabase/server";

// Gym-day reminder push. Must be called hourly with `Authorization: Bearer <CRON_SECRET>`,
// by Vercel Cron on a Pro plan (vercel.json snippet in lib/push/reminderJob.ts; Hobby
// only allows daily crons) or by an external scheduler (Supabase pg_cron + pg_net, or a
// free cron service). See lib/push/reminderJob.ts.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handleReminderCron(req, {
    env: process.env,
    store: () => supabaseReminderStore(supabaseAdmin()),
    send: () => getPushSender(process.env),
  });
}
