import catalogueJson from "@/data/exercises.json";
import type { Exercise } from "@/lib/exercises";
import { actionSigner, handleReminderCron, supabaseNudgeStore, supabaseReminderStore } from "@/lib/push/reminderJob";
import { getPushSender } from "@/lib/push/send";
import { supabaseAdmin } from "@/lib/supabase/server";

// Gym-day reminder push. Must be called hourly with `Authorization: Bearer <CRON_SECRET>`,
// by Vercel Cron on a Pro plan (vercel.json snippet in lib/push/reminderJob.ts; Hobby
// only allows daily crons) or by an external scheduler (Supabase pg_cron + pg_net, or a
// free cron service). See lib/push/reminderJob.ts.
// Also sends the "haven't gone yet" and "behind on weekly goal" nudges (lib/push/nudges.ts)
// and adds Skip today / Snooze buttons handled by /api/push/action.
export const dynamic = "force-dynamic";

const musclesById = new Map((catalogueJson as unknown as Exercise[]).map((e) => [e.id, e.muscle_groups]));

export async function GET(req: Request) {
  return handleReminderCron(req, {
    env: process.env,
    store: () => supabaseReminderStore(supabaseAdmin()),
    send: () => getPushSender(process.env),
    extras: () => ({
      nudges: supabaseNudgeStore(supabaseAdmin()),
      muscleOf: (id) => musclesById.get(id) ?? [],
      signAction: actionSigner(process.env.CRON_SECRET ?? "", new Date()),
    }),
  });
}
