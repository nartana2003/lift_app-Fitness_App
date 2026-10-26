import { after } from "next/server";
import { supabaseUserResolver } from "@/lib/ai/guard";
import { getPushSender } from "@/lib/push/send";
import {
  createRestScheduler,
  createRestTimerLimiter,
  handleRestTimer,
  supabaseRestSubscriptionStore,
  type RestTimerDeps,
} from "@/lib/restTimerPush";
import { supabaseAdmin } from "@/lib/supabase/server";

// Rest-timer push: POST schedules a "Rest over" push to this phone after delaySec,
// DELETE cancels it. See lib/restTimerPush.ts.
export const dynamic = "force-dynamic";
// The wait runs inside this function; MAX_REST_DELAY_SEC (290) stays below it.
export const maxDuration = 300;

const limiter = createRestTimerLimiter();
const scheduler = createRestScheduler();

const deps = (): RestTimerDeps => ({
  env: process.env,
  resolveUser: supabaseUserResolver,
  store: () => supabaseRestSubscriptionStore(supabaseAdmin()),
  send: () => getPushSender(process.env),
  limiter,
  scheduler,
  keepAlive: (p) => after(p),
});

export async function POST(req: Request) {
  return handleRestTimer(req, deps());
}

export async function DELETE(req: Request) {
  return handleRestTimer(req, deps());
}
