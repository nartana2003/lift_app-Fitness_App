import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import { MAX_BODY_BYTES, buildContext, buildPrompt, parseResponseText, validateInput } from "@/lib/ai/goal-targets";

export const dynamic = "force-dynamic";

/**
 * POST { goals, split?, recent_weeks? } -> 200 { targets, adjusted } with one
 * weekly set target (4..24) and reason per muscle group, covering every group.
 * 503 {unavailable:true} with no key (the app keeps its rule-based targets from
 * lib/goals.ts), 400/413 for a bad body, and the shared AI failure codes otherwise.
 */
export async function POST(req: Request): Promise<Response> {
  return withAiClient(async (client) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) return invalidRequest(body.status);
    const checked = validateInput(body.value);
    if (!checked.ok) return invalidRequest();

    const ctx = buildContext(checked.input);
    const result = await runAi(client, buildPrompt(ctx));
    if (!result.ok) return aiFailure(result.reason);

    const targets = parseResponseText(result.text, ctx);
    if (!targets) return aiFailure("error");
    return aiOk(targets);
  });
}
