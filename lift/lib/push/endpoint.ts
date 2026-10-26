/**
 * Pure, shared by server and client. Web Push subscription shape, validation
 * and config checks. The server POSTs to a subscription's endpoint, so only
 * the browser vendors' push services are accepted (no request to arbitrary
 * hosts from a user-supplied URL).
 */

export type PushKeys = { p256dh: string; auth: string };
export type PushSub = { endpoint: string; keys: PushKeys };

export type PushEnv = Partial<Record<string, string | undefined>>;

/** Exact push service hosts, plus suffixes for vendors with per-region hosts. */
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com", ".push.services.mozilla.com"];

export const MAX_ENDPOINT_LENGTH = 1024;

/** True for an https URL on a known browser push service. */
export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  // Only the canonical form: new URL() would trim whitespace, but the raw string is what gets stored.
  if (endpoint !== endpoint.trim() || /\s/.test(endpoint)) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const isKey = (v: unknown, min: number, max: number): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max && B64URL.test(v);

/** p256dh is a 65-byte P-256 point (87 chars), auth a 16-byte secret (22 chars). */
export function isPushKeys(v: unknown): v is PushKeys {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "p256dh" && k !== "auth")) return false;
  return isKey(o.p256dh, 80, 100) && isKey(o.auth, 16, 32);
}

/** A stored or posted subscription, cleaned, or null. */
export function toPushSub(v: unknown): PushSub | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isAllowedPushEndpoint(o.endpoint) || !isPushKeys(o.keys)) return null;
  return { endpoint: o.endpoint, keys: { p256dh: o.keys.p256dh, auth: o.keys.auth } };
}

const filled = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

/** Server can send pushes: VAPID public + private key and a subject. */
export function vapidConfiguredFrom(env: PushEnv): boolean {
  return filled(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) && filled(env.VAPID_PRIVATE_KEY) && filled(env.VAPID_SUBJECT);
}

/** Server can use the service-role Supabase client (cron + subscription storage). */
export function adminConfiguredFrom(env: PushEnv): boolean {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  return Boolean(url && !url.includes("YOUR-PROJECT") && filled(env.SUPABASE_SERVICE_ROLE_KEY));
}

/** VAPID public key (base64url) to the bytes PushManager.subscribe wants. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
