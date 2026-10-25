import catalogueJson from "@/data/exercises.json";
import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import {
  MAX_BODY_BYTES,
  buildContext,
  buildPrompt,
  parseResponseText,
  validateInput,
} from "@/lib/ai/generate-routines";
import type { Exercise } from "@/lib/exercises";

export const dynamic = "force-dynamic";

const catalogue = catalogueJson as unknown as Exercise[];

/**
 * POST { split, equipment, history, plan_days?, favorites?, request? } -> 200
 * { plan } with a plan_days-day plan (3 when absent) whose exercise ids are all
 * in the built-in catalogue. Favourites that fit a day go first (also when the
 * model ignores them); the typed request only reaches the model inside the
 * escaped <user_data> block.
 * 503 {unavailable:true} with no key (the app keeps its rule-based flow),
 * 400/413 for a bad body, and the shared AI failure codes otherwise.
 */
export async function POST(req: Request): Promise<Response> {
  return withAiClient(async (client) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) return invalidRequest(body.status);
    const raw = body.value;
    const checked = validateInput(raw);
    if (!checked.ok) return invalidRequest();

    const ctx = buildContext(checked.input, catalogue);
    const result = await runAi(client, buildPrompt(ctx));
    if (!result.ok) return aiFailure(result.reason);

    const plan = parseResponseText(result.text, ctx);
    if (!plan) return aiFailure("error");
    return aiOk({ plan });
  });
}
