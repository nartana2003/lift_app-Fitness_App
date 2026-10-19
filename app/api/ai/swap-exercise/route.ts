import catalogueJson from "@/data/exercises.json";
import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import { MAX_BODY_BYTES, buildContext, buildPrompt, parseResponseText, ruleSwap, validateInput } from "@/lib/ai/swap-exercise";
import type { Exercise } from "@/lib/exercises";

export const dynamic = "force-dynamic";

const catalogue = catalogueJson as unknown as Exercise[];
const byId = new Map(catalogue.map((e) => [e.id, e]));

/**
 * POST { exercise_id, reason, equipment?, exclude? } -> 200 { exercise_id, alternatives, adjusted }:
 * up to 6 ranked catalogue alternatives, each with a reason. reason is one of
 * lib/swap.ts SwapReason ("busy" | "equipment" | "hurts" | "variety").
 * 503 {unavailable:true} with no key (the swap sheet keeps its rule-based
 * list from swapOptions; ruleSwap in lib/ai/swap-exercise.ts gives the same
 * shape without the model), 400/413 for a bad body, and the shared AI failure
 * codes otherwise.
 */
export async function POST(req: Request): Promise<Response> {
  return withAiClient(async (client) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) return invalidRequest(body.status);
    const checked = validateInput(body.value, byId);
    if (!checked.ok) return invalidRequest();

    const ctx = buildContext(checked.input, catalogue);
    if (!ctx) return invalidRequest();
    // Nothing to rank: answer without spending a model call.
    if (ctx.candidates.length === 0) return aiOk(ruleSwap(ctx));
    const result = await runAi(client, buildPrompt(ctx));
    if (!result.ok) return aiFailure(result.reason);

    const swap = parseResponseText(result.text, ctx);
    if (!swap) return aiFailure("error");
    return aiOk(swap);
  });
}
