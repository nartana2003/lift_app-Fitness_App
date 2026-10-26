/**
 * Login return-to. Pure and edge-safe, shared by middleware.ts, the login page
 * and the /auth/callback route.
 *
 * A signed-out visit to a protected page (for example /save?url=... from the
 * iOS Shortcut) is sent to /login?next=<that path>. After sign-in the user
 * goes back to `next`, but only when it is a same-origin relative path, so the
 * parameter can never be used as an open redirect.
 */

export const NEXT_PARAM = "next";
export const LOGIN_PATH = "/login";

/** Longest `next` value accepted; longer ones fall back to the home page. */
export const MAX_NEXT_LENGTH = 2048;

const PROBE_ORIGIN = "https://lift.invalid";

/**
 * Returns `raw` as a safe same-origin path ("/save?url=..."), or `fallback`.
 * Rejected: absolute URLs, protocol-relative ("//evil"), backslash tricks
 * ("/\evil"), control or whitespace characters, anything that resolves to
 * another origin, and the login page itself (no redirect loop).
 */
export function safeNext(raw: string | null | undefined, fallback = "/"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  // Browsers treat "\" like "/" in URLs, and strip tabs/newlines: refuse both.
  if (/[\\\x00-\x20\x7f-\x9f]/.test(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;
  if (url.pathname === LOGIN_PATH || url.pathname.startsWith(`${LOGIN_PATH}/`)) return fallback;
  if (url.pathname.startsWith("//")) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

export const AUTH_CALLBACK_PATH = "/auth/callback";

/** Absolute e-mail confirmation link target: `${origin}/auth/callback?next=<safe path>`. */
export function authCallbackUrl(origin: string, next: string | null | undefined): string {
  const safe = safeNext(next);
  const q = safe === "/" ? "" : `?${NEXT_PARAM}=${encodeURIComponent(safe)}`;
  return `${origin}${AUTH_CALLBACK_PATH}${q}`;
}

/** "/login?next=<encoded path+search>" for a signed-out visit to `pathname` + `search`. */
export function loginPathFor(pathname: string, search = ""): string {
  const next = safeNext(`${pathname}${search}`, "");
  if (!next || next === "/") return LOGIN_PATH;
  return `${LOGIN_PATH}?${NEXT_PARAM}=${encodeURIComponent(next)}`;
}
