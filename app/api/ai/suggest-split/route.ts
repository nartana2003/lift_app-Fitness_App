import catalogueJson from "@/data/exercises.json";
import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import { MAX_BODY_BYTES, buildContext, buildPrompt, resolveResponse, validateInput } from "@/lib/ai/suggest-split";
import type { Exercise } from "@/lib/exercises";

export const dynamic = "force-dynamic";

const catalogue = catalogueJson as unknown as Exercise[];
const byId = new Map(catalogue.map((e) => [e.id, e]));

/**
 * POST { favorites?, request?, days_per_week?, equipment? } -> 200
 * { split: { name, days: [{ name, muscles }] }, notes, source }: a 2 to 6 day
 * split whose muscles all come from MUSCLE_GROUPS. When the model's answer is
 * unusable the rule-based buildSplit() answer is returned with source "rules".
 * 503 {unavailable:true} with no key (before the body is read), 400/413 for a
 * bad, tag-like or oversized body, and the shared AI failure codes otherwise.
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
    return aiOk(resolveResponse(result.text, ctx));
  });
}
