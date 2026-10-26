import catalogueJson from "@/data/exercises.json";
import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import { MAX_BODY_BYTES, buildContext, buildPrompt, parseResponseText, validateInput } from "@/lib/ai/plateau-fix";
import type { Exercise } from "@/lib/exercises";

export const dynamic = "force-dynamic";

const catalogue = catalogueJson as unknown as Exercise[];
const byId = new Map(catalogue.map((e) => [e.id, e]));

/**
 * POST { exercise_id, sessions, equipment?, goal_type? } -> 200
 * { exercise_id, weeks, best_e1rm, last_e1rm, sessions, fix, source, adjusted }:
 * one recommended fix (rep_range, swap, extra_set or deload) for a stalled lift.
 * 503 {unavailable:true} with no key (the Progress card keeps its rule-based
 * advice; ruleFix in lib/ai/plateau-fix.ts gives the same shape without the
 * model), 400/413 for a bad body or a history that is not stalled, and the
 * shared AI failure codes otherwise.
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

    const fix = parseResponseText(result.text, ctx);
    if (!fix) return aiFailure("error");
    return aiOk(fix);
  });
}
