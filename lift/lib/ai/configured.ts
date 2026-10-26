/**
 * Server-only. False until the server env has a real ANTHROPIC_API_KEY — AI
 * features then report "unavailable" and the rule-based fallbacks carry the app.
 *
 * Mirrors lib/supabase/configured.ts. The key is deliberately NOT prefixed with
 * NEXT_PUBLIC_, so Next.js never inlines it into client bundles; in the browser
 * this always evaluates to false.
 */
export type AiEnv = Partial<Record<string, string | undefined>>;

/** True when the given env holds a usable (non-placeholder) Anthropic API key. */
export function aiConfiguredFrom(env: AiEnv): boolean {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return Boolean(key && !key.includes("YOUR-") && !key.includes("your-"));
}

export const aiConfigured = aiConfiguredFrom(process.env);
