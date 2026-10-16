import catalogueJson from "@/data/exercises.json";
import { runAi } from "@/lib/ai/client";
import { aiFailure, aiOk, withAiClient } from "@/lib/ai/respond";
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

const invalid = (status: 400 | 413 = 400) => Response.json({ error: "invalid_request" }, { status });

/**
 * POST { split, equipment, history } -> 200 { plan } with a 3-day plan whose
 * exercise ids are all in the built-in catalogue.
 * 503 {unavailable:true} with no key (the app keeps its rule-based flow),
 * 400/413 for a bad body, and the shared AI failure codes otherwise.
 */
export async function POST(req: Request): Promise<Response> {
  return withAiClient(async (client) => {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return invalid(413);
    let text: string;
    try {
      text = await req.text();
    } catch {
      return invalid();
    }
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return invalid(413);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return invalid();
    }
    const checked = validateInput(raw);
    if (!checked.ok) return invalid();

    const ctx = buildContext(checked.input, catalogue);
    const result = await runAi(client, buildPrompt(ctx));
    if (!result.ok) return aiFailure(result.reason);

    const plan = parseResponseText(result.text, ctx);
    if (!plan) return aiFailure("error");
    return aiOk({ plan });
  });
}
