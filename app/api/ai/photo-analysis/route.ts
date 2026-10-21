import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import { MAX_BODY_BYTES, buildPrompt, parseResponseText, validateInput } from "@/lib/ai/photo-analysis";

export const dynamic = "force-dynamic";
/** Images are decoded with Buffer. */
export const runtime = "nodejs";

/**
 * POST { month, unit?, photos: [{ taken_on, pose?, media_type, data }], stats }
 * -> 200 { month, comment, comment_source, focus, adjusted }: a short monthly
 * progress comment from the first and last progress photos and the month's
 * stats.
 * 503 {unavailable:true} with no key (rulePhotoAnalysis in
 * lib/ai/photo-analysis.ts gives the same shape without the model), 400/413
 * {error:"invalid_request"} for a bad or oversized body or image, and the
 * shared AI failure codes otherwise. No response ever contains image data.
 */
export async function POST(req: Request): Promise<Response> {
  return withAiClient(async (client) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) return invalidRequest(body.status);
    const checked = validateInput(body.value);
    if (!checked.ok) return invalidRequest();

    const result = await runAi(client, buildPrompt(checked.input));
    if (!result.ok) return aiFailure(result.reason);

    const analysis = parseResponseText(result.text, checked.input);
    if (!analysis) return aiFailure("error");
    return aiOk(analysis);
  });
}
