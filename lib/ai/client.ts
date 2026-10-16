/**
 * Server-only. The single wrapper around @anthropic-ai/sdk. Every AI route
 * (app/api/ai/*) goes through getAiClient() + runAi(); nothing else in the app
 * imports the SDK.
 *
 * - The key is read only from ANTHROPIC_API_KEY on the server. It is never
 *   logged, never returned, and never put into an error or result.
 * - Tests inject a fake client with setAiClientFactory(); no real key needed.
 */
import Anthropic from "@anthropic-ai/sdk";
import { aiConfiguredFrom, type AiEnv } from "./configured";

/** Model for every Lift AI feature. */
export const AI_MODEL = "claude-sonnet-5-5";

/** Default output cap; routes return short structured JSON or a short recap. */
export const AI_MAX_TOKENS = 16000;

/** Server-side refusal fallback ("default" routing, Claude API only). */
export const AI_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type AiParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type AiMessage = Anthropic.Beta.Messages.BetaMessage;

/** What a route supplies: everything except the fields the wrapper owns. */
export type AiRequest = Omit<AiParams, "model" | "max_tokens" | "betas" | "fallbacks" | "stream"> & {
  max_tokens?: number;
};

/** The narrow seam routes depend on. A fake only has to implement this. */
export interface AiClient {
  createMessage(params: AiParams): Promise<AiMessage>;
}

export type AiClientFactory = (apiKey: string) => AiClient;

/** Real SDK client. The key is passed explicitly so no other credential source is used. */
export const sdkClientFactory: AiClientFactory = (apiKey) => {
  const sdk = new Anthropic({ apiKey, authToken: null });
  return { createMessage: (params) => sdk.beta.messages.create(params) };
};

let factory: AiClientFactory = sdkClientFactory;

/** Test seam: swap in a fake factory; pass null to restore the real SDK. */
export function setAiClientFactory(next: AiClientFactory | null): void {
  factory = next ?? sdkClientFactory;
}

/**
 * Returns a client when the server has a key, else null (callers then answer
 * with aiUnavailable()). Always null in the browser.
 */
export function getAiClient(env: AiEnv = process.env): AiClient | null {
  if (typeof window !== "undefined") return null;
  if (!aiConfiguredFrom(env)) return null;
  return factory(env.ANTHROPIC_API_KEY!.trim());
}

/** Fill in the fields the wrapper owns: model, output cap and refusal fallback. */
export function buildParams(req: AiRequest): AiParams {
  return {
    ...req,
    model: AI_MODEL,
    max_tokens: req.max_tokens ?? AI_MAX_TOKENS,
    betas: [AI_FALLBACK_BETA],
    fallbacks: "default",
  };
}

/** Concatenated text blocks of a response (thinking and tool blocks ignored). */
export function messageText(msg: AiMessage): string {
  let out = "";
  for (const block of msg.content) if (block.type === "text") out += block.text;
  return out;
}

export type AiFailureReason = "unavailable" | "refused" | "truncated" | "rate_limited" | "error";

export type AiResult =
  | { ok: true; text: string; message: AiMessage }
  | { ok: false; reason: AiFailureReason };

/**
 * One call to Claude. Never throws: SDK errors are mapped to a reason code and
 * their messages are dropped, so nothing from the request (including the key)
 * can leak into a response.
 */
export async function runAi(client: AiClient | null, req: AiRequest): Promise<AiResult> {
  if (!client) return { ok: false, reason: "unavailable" };
  let message: AiMessage;
  try {
    message = await client.createMessage(buildParams(req));
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return { ok: false, reason: "rate_limited" };
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, reason: "unavailable" };
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, reason: "unavailable" };
    return { ok: false, reason: "error" };
  }
  if (message.stop_reason === "refusal") return { ok: false, reason: "refused" };
  if (message.stop_reason === "max_tokens") return { ok: false, reason: "truncated" };
  return { ok: true, text: messageText(message), message };
}
