import catalogueJson from "@/data/exercises.json";
import { runAi } from "@/lib/ai/client";
import { aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import {
  MAX_BODY_BYTES,
  buildContext,
  buildPrompt,
  evidenceFromMessage,
  hasCandidates,
  ruleEvidence,
  validateInput,
} from "@/lib/ai/evidence-picks";
import type { Exercise } from "@/lib/exercises";

export const dynamic = "force-dynamic";

const catalogue = catalogueJson as unknown as Exercise[];

/**
 * POST { goals: {goalType, experience, sessionsPerWeek?, focusMuscles}, muscles (max 6), equipment? }
 * -> 200 { picks, sources, evidence, disclaimer, source: "ai" | "rules" }.
 *
 * 503 {unavailable:true} with no key, before the body is read (the client
 * then shows the COACH-01 suggestions itself). 400/413 for a bad body. Any
 * other failure (model error, refusal, truncation, a search error result,
 * unusable output, no cited pick) answers 200 with the rule-based
 * suggestions, source "rules" and no sources.
 */
export async function POST(req: Request): Promise<Response> {
  return withAiClient(async (client) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) return invalidRequest(body.status);
    const checked = validateInput(body.value);
    if (!checked.ok) return invalidRequest();

    const ctx = buildContext(checked.input, catalogue);
    // Nothing to pick from: answer without spending a model call.
    if (!hasCandidates(ctx)) return aiOk(ruleEvidence(ctx));
    const result = await runAi(client, buildPrompt(ctx));
    if (!result.ok) return aiOk(ruleEvidence(ctx));
    return aiOk(evidenceFromMessage(result.message, ctx));
  });
}
