import catalogueJson from "@/data/exercises.json";
import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import { MAX_BODY_BYTES, buildContext, buildPrompt, parseResponseText, validateInput } from "@/lib/ai/overload-suggestion";
import type { Exercise } from "@/lib/exercises";

export const dynamic = "force-dynamic";

const catalogue = catalogueJson as unknown as Exercise[];

/**
 * POST { exercise_id, sessions, equipment?, rep_range?, goals? } ->
 * 200 { exercise_id, suggestion, rule, adjusted }: today's sets x reps x weight
 * with a one-line reason, refined from the rule-based default (also returned
 * as `rule`) and clamped to a window around the last session.
 * 503 {unavailable:true} with no key (the app keeps lib/overload.ts suggest();
 * ruleResult in lib/ai/overload-suggestion.ts gives the same shape without the
 * model), 400/413 for a bad body, and the shared AI failure codes otherwise.
 */
export async function POST(req: Request): Promise<Response> {
  return withAiClient(async (client) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) return invalidRequest(body.status);
    const checked = validateInput(body.value);
    if (!checked.ok) return invalidRequest();

    const ctx = buildContext(checked.input, catalogue);
    const result = await runAi(client, buildPrompt(ctx));
    if (!result.ok) return aiFailure(result.reason);

    const suggestion = parseResponseText(result.text, ctx);
    if (!suggestion) return aiFailure("error");
    return aiOk(suggestion);
  });
}
