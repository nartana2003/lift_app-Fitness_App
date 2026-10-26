import { supabaseUserResolver } from "@/lib/ai/guard";
import { createSubscribeLimiter, handlePushSubscription, supabaseSubscriptionStore, type SubscribeDeps } from "@/lib/push/subscribe";
import { supabaseAdmin } from "@/lib/supabase/server";

// Save (POST) or remove (DELETE) this phone's push subscription. See lib/push/subscribe.ts.
const limiter = createSubscribeLimiter();

const deps = (): SubscribeDeps => ({
  env: process.env,
  resolveUser: supabaseUserResolver,
  store: () => supabaseSubscriptionStore(supabaseAdmin()),
  limiter,
});

export async function POST(req: Request) {
  return handlePushSubscription(req, deps());
}

export async function DELETE(req: Request) {
  return handlePushSubscription(req, deps());
}
