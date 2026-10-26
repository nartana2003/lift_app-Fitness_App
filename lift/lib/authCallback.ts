/**
 * Server-only. GET /auth/callback: the link in the sign-up confirmation e-mail.
 * Exchanges the one-time `code` for a session cookie, then sends the user to
 * the safe `next` path (lib/authRedirect.ts), e.g. back to /save?url=...
 * The redirect is always built on the request's own origin.
 */
import { LOGIN_PATH, NEXT_PARAM, safeNext } from "./authRedirect";

/** Exchanges the code for a session; returns an error message or null. */
export type CodeExchange = (code: string) => Promise<string | null>;

/** Longest code accepted before asking Supabase. */
const MAX_CODE_LENGTH = 512;

export async function handleAuthCallback(request: Request, exchange: CodeExchange): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get(NEXT_PARAM));
  const toLogin = () => {
    const dest = new URL(LOGIN_PATH, url.origin);
    if (next !== "/") dest.searchParams.set(NEXT_PARAM, next);
    dest.searchParams.set("error", "link");
    return Response.redirect(dest, 303);
  };
  if (!code || code.length > MAX_CODE_LENGTH) return toLogin();
  let failed: string | null;
  try {
    failed = await exchange(code);
  } catch {
    failed = "exchange failed";
  }
  if (failed) return toLogin();
  return Response.redirect(new URL(next, url.origin), 303);
}
