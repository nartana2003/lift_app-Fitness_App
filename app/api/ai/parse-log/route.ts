import catalogueJson from "@/data/exercises.json";
import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import { MAX_BODY_BYTES, buildContext, buildPrompt, parseResponseText, validateInput } from "@/lib/ai/parse-log";
import type { Exercise } from "@/lib/exercises";

export const dynamic = "force-dynamic";

const catalogue = catalogueJson as unknown as Exercise[];

/**
 * POST { text, unit? } -> 200 { exercises, unit, adjusted }: the typed or
 * dictated workout text parsed into exercises (catalogue ids, or null when
 * nothing matched) with sets of { reps, weight_kg }. unit is "kg" | "lb"
 * (default "kg") and is only used to read weights the text gives without a
 * unit; weights always come back in kg.
 * 503 {unavailable:true} with no key (manual logging is unchanged; ruleParse
 * in lib/ai/parse-log.ts gives the same shape without the model), 400/413 for
 * a bad, tag-like or over-long body, and the shared AI failure codes otherwise.
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

    const parsed = parseResponseText(result.text, ctx);
    if (!parsed) return aiFailure("error");
    return aiOk(parsed);
  });
}
