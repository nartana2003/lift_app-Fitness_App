import { handleAuthCallback } from "@/lib/authCallback";
import { supabaseConfigured } from "@/lib/supabase/configured";

// Sign-up confirmation link target. See lib/authCallback.ts.
export async function GET(request: Request) {
  return handleAuthCallback(request, async (code) => {
    if (!supabaseConfigured) return "not configured";
    const { supabaseServer } = await import("@/lib/supabase/server");
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    return error ? "exchange failed" : null;
  });
}
