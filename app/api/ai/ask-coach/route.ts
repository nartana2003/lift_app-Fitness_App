import catalogueJson from "@/data/exercises.json";
import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import { MAX_BODY_BYTES, buildContext, buildPrompt, contextExceeded, parseResponseText, validateInput } from "@/lib/ai/ask-coach";
import type { Exercise } from "@/lib/exercises";

export const dynamic = "force-dynamic";

const catalogue = catalogueJson as unknown as Exercise[];
const byId = new Map(catalogue.map((e) => [e.id, e]));

/**
 * POST { question, unit?, goal_type?, experience?, sessions_per_week?,
 * workouts_28d?, muscles?, exercises?, history? } -> 200 { answer, exercise_ids,
 * source, adjusted }: a short answer to the user's question grounded in the
 * data sent. exercise_ids only ever holds ids from the request's exercises.
 * 503 {unavailable:true} with no key (ruleAnswer in lib/ai/ask-coach.ts gives
 * the same shape without the model), 400/413 for a bad, tag-like or over-long
 * body, "truncated" (502) when the answer was cut off by max_tokens or the
 * context window, and the shared AI failure codes otherwise.
 */
export async function POST(req: Request): Promise<Response> {
  return withAiClient(async (client) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) return invalidRequest(body.status);
    const checked = validateInput(body.value, byId);
    if (!checked.ok) return invalidRequest();

    const ctx = buildContext(checked.input, catalogue);
    const result = await runAi(client, buildPrompt(ctx));
    if (!result.ok) return aiFailure(result.reason);
    if (contextExceeded(result.message)) return aiFailure("truncated");

    const parsed = parseResponseText(result.text, ctx);
    if (!parsed) return aiFailure("error");
    return aiOk(parsed);
  });
}
