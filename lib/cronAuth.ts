/**
 * Cron route guard. Every route under /api/cron must be called with
 * `Authorization: Bearer <CRON_SECRET>` (the header Vercel Cron sends).
 * Fails closed: with no CRON_SECRET set, nothing is authorised.
 * Pure and edge-safe (no node:crypto), so middleware and route handlers can share it.
 */

export const CRON_PREFIX = "/api/cron";

/** True for /api/cron and anything below it, not for look-alikes such as /api/cronjob. */
export function isCronPath(pathname: string): boolean {
  return pathname === CRON_PREFIX || pathname.startsWith(`${CRON_PREFIX}/`);
}

/** Length-independent-time string compare, so the secret cannot be guessed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Checks an Authorization header value against the configured secret. */
export function isCronAuthorized(authorization: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !authorization) return false;
  return safeEqual(authorization, `Bearer ${secret}`);
}
