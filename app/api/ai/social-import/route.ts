import catalogueJson from "@/data/exercises.json";
import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import { MAX_BODY_BYTES, buildPrompt, indexCatalogue, parseResponseText, validateInput } from "@/lib/ai/social-import";
import type { Exercise } from "@/lib/exercises";

export const dynamic = "force-dynamic";

const catalogue = catalogueJson as unknown as Exercise[];
const index = indexCatalogue(catalogue);

/**
 * POST { platform?, title?, caption?, notes? } -> 200 { name, platform, exercises, notes, adjusted }:
 * a mini workout from a TikTok / Instagram / YouTube post. Each exercise is a
 * catalogue id, or exercise_id null with a validated custom name for the
 * client to create. No URL is accepted and nothing is fetched: the client
 * keeps the link. 503 {unavailable:true} with no key (the user adds the
 * exercises by hand), 400/413 for a bad body, and the shared AI failure codes
 * otherwise.
 */
export async function POST(req: Request): Promise<Response> {
  return withAiClient(async (client) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) return invalidRequest(body.status);
    const checked = validateInput(body.value);
    if (!checked.ok) return invalidRequest();

    const result = await runAi(client, buildPrompt(checked.input, catalogue));
    if (!result.ok) return aiFailure(result.reason);

    const workout = parseResponseText(result.text, checked.input, index);
    if (!workout) return aiFailure("error");
    return aiOk(workout);
  });
}
