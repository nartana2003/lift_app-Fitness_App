import catalogueJson from "@/data/exercises.json";
import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import { MAX_BODY_BYTES, buildContext, buildPrompt, parseResponseText, validateInput } from "@/lib/ai/goal-gaps";
import type { Exercise } from "@/lib/exercises";

export const dynamic = "force-dynamic";

const catalogue = catalogueJson as unknown as Exercise[];

/**
 * POST { gaps, days_left, equipment?, goals? } -> 200 { additions, unmet, adjusted }:
 * catalogue exercises to add for each under-target muscle and the day (one of
 * days_left) for each, at most 3 per day.
 * 503 {unavailable:true} with no key (the app keeps its rule-based suggestions;
 * rulePlan in lib/ai/goal-gaps.ts gives the same shape without the model),
 * 400/413 for a bad body, and the shared AI failure codes otherwise.
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

    const gaps = parseResponseText(result.text, ctx);
    if (!gaps) return aiFailure("error");
    return aiOk(gaps);
  });
}
