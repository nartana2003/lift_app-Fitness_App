/**
 * Shared HTTP answers for app/api/ai/* routes. Bodies are fixed shapes with no
 * error text, so nothing from the SDK or the env can leak to the client.
 * The client treats any non-2xx as "use the rule-based fallback".
 */
import { getAiClient, type AiClient, type AiFailureReason } from "./client";
import type { AiEnv } from "./configured";
import { guardAiRequest } from "./guard";

export type AiUnavailableBody = { unavailable: true };
export type AiErrorBody = { error: Exclude<AiFailureReason, "unavailable"> };

/** 503 {unavailable:true}: no key on the server, or Claude cannot be reached. */
export function aiUnavailable(): Response {
  return Response.json({ unavailable: true } satisfies AiUnavailableBody, { status: 503 });
}

const STATUS: Record<Exclude<AiFailureReason, "unavailable">, number> = {
  rate_limited: 429,
  refused: 422,
  truncated: 502,
  error: 502,
};

/** Map a failed runAi() result to a response. */
export function aiFailure(reason: AiFailureReason): Response {
  if (reason === "unavailable") return aiUnavailable();
  return Response.json({ error: reason } satisfies AiErrorBody, { status: STATUS[reason] });
}

/** 200 with a JSON body. */
export function aiOk<T>(data: T): Response {
  return Response.json(data, { status: 200 });
}

/**
 * Route helper: run `fn` with a client, or answer 503 {unavailable:true}
 * when the server has no key. With Supabase configured the caller must be
 * signed in (401 {error:"unauthorized"}) and under the per-user rate limit
 * (429 {error:"rate_limited"}); see lib/ai/guard.ts. Both checks run before
 * `fn`, so before the route reads its body.
 */
export async function withAiClient(
  fn: (client: AiClient) => Promise<Response>,
  env: AiEnv = process.env,
): Promise<Response> {
  const client = getAiClient(env);
  if (!client) return aiUnavailable();
  const blocked = await guardAiRequest(env);
  if (blocked) return blocked;
  return fn(client);
}
