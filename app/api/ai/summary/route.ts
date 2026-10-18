import catalogueJson from "@/data/exercises.json";
import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import { MAX_BODY_BYTES, buildContext, buildPrompt, parseResponseText, validateInput } from "@/lib/ai/summary";
import type { Exercise } from "@/lib/exercises";

export const dynamic = "force-dynamic";

const catalogue = catalogueJson as unknown as Exercise[];
const byId = new Map(catalogue.map((e) => [e.id, e]));

/**
 * POST { period, unit?, current, previous?, highlights? } -> 200
 * { period, recap, recap_source, advice, adjusted }: a short coach-style
 * weekly or monthly recap with progressive-overload advice.
 * 503 {unavailable:true} with no key (ruleSummary in lib/ai/summary.ts gives
 * the same shape without the model), 400/413 for a bad body, and the shared AI
 * failure codes otherwise.
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

    const summary = parseResponseText(result.text, ctx);
    if (!summary) return aiFailure("error");
    return aiOk(summary);
  });
}
