import { supabaseUserResolver } from "@/lib/ai/guard";
import { createFeedbackLimiter, DEFAULT_FEEDBACK_REPO, githubFeedback, handleFeedbackList, handleFeedbackSubmit, supabaseFeedbackStore, type FeedbackDeps } from "@/lib/feedback/submit";
import { supabaseServer } from "@/lib/supabase/server";

// Send feedback as a GitHub issue (POST) or list your past feedback (GET). See lib/feedback/submit.ts.
const limiter = createFeedbackLimiter();

const deps = (): FeedbackDeps => ({
  env: process.env,
  resolveUser: supabaseUserResolver,
  github: () => githubFeedback(process.env.GITHUB_FEEDBACK_TOKEN!.trim(), process.env.GITHUB_FEEDBACK_REPO?.trim() || DEFAULT_FEEDBACK_REPO),
  store: async () => supabaseFeedbackStore(await supabaseServer()),
  limiter,
});

export async function POST(req: Request) {
  return handleFeedbackSubmit(req, deps());
}

export async function GET() {
  return handleFeedbackList(deps());
}
