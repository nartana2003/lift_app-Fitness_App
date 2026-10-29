import catalogueJson from "@/data/exercises.json";
import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import { MAX_BODY_BYTES, buildContext, buildPrompt, resolveResponse, validateInput } from "@/lib/ai/optimise-split";
import type { Exercise } from "@/lib/exercises";

export const dynamic = "force-dynamic";

const catalogue = catalogueJson as unknown as Exercise[];
const byId = new Map(catalogue.map((e) => [e.id, e]));

/**
 * POST { goals: { goalType, experience, sessionsPerWeek, focusMuscles?, priorities?, targets?,
 * limitations?, dislikedIds? }, split: { name?, days: [{ id, name, muscles }] },
 * routines?: [{ id, split_day_id, exercises: [{ exercise_id, target_sets, target_reps }] }],
 * equipment? } -> 200 { notes: string[], changes: Change[], emptied: MuscleGroup[], source }.
 * The rules (lib/coachOptimise.ts) decide the changes. The model only orders them and
 * re-words each reason; its answer is clamped to the proposed change ids. When it is
 * unusable, or there is nothing to change, the rule answer is returned with source
 * "rules" and the model is not called. 503 {unavailable:true} with no key (before the
 * body is read; the client then runs the same rules itself), 400/413 for a bad,
 * tag-like or oversized body, and the shared AI failure codes otherwise.
 */
export async function POST(req: Request): Promise<Response> {
  return withAiClient(async (client) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) return invalidRequest(body.status);
    const checked = validateInput(body.value, byId);
    if (!checked.ok) return invalidRequest();

    const ctx = buildContext(checked.input, catalogue);
    if (ctx.proposals.changes.length === 0) return aiOk(ctx.rule);
    const result = await runAi(client, buildPrompt(ctx));
    if (!result.ok) return aiFailure(result.reason);
    return aiOk(resolveResponse(result.text, ctx));
  });
}
