import { handleReminderCron, supabaseReminderStore } from "@/lib/push/reminderJob";
import { getPushSender } from "@/lib/push/send";
import { supabaseAdmin } from "@/lib/supabase/server";

// Hourly gym-day reminder push (vercel.json). Bearer CRON_SECRET required. See lib/push/reminderJob.ts.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handleReminderCron(req, {
    env: process.env,
    store: () => supabaseReminderStore(supabaseAdmin()),
    send: () => getPushSender(process.env),
  });
}
