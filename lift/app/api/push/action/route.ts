import { createActionLimiter, handleReminderAction, supabaseReminderActionStore } from "@/lib/push/reminderAction";
import { supabaseAdmin } from "@/lib/supabase/server";

// Skip today / Snooze from a reminder notification (public/sw.js). See lib/push/reminderAction.ts.
export const dynamic = "force-dynamic";

const limiter = createActionLimiter();

export async function POST(req: Request) {
  return handleReminderAction(req, {
    env: process.env,
    store: () => supabaseReminderActionStore(supabaseAdmin()),
    limiter,
  });
}
