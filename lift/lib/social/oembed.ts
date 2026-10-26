/**
 * Server-only pure logic (plus one fetch helper) for POST /api/social/import.
 *
 * A pasted TikTok, YouTube/Shorts or Instagram link goes in; the post's title,
 * thumbnail and creator come out, read from the platform's PUBLIC oEmbed
 * endpoint. Instagram needs a Meta app token for oEmbed, so it (and any
 * failure) answers { platform, manual: true } and the UI falls back to the
 * pasted caption.
 *
 * SSRF safety:
 * - The incoming link must be https on an EXACT allow-listed host (no
 *   suffix matching, no credentials, no custom port, no trailing-dot host).
 * - The server only ever fetches one of two FIXED endpoints
 *   (OEMBED_ENDPOINTS); the user's link is only ever a query parameter.
 * - redirect: "manual" (a redirect is a failure, never followed), a timeout,
 *   a response byte cap, and JSON content only.
 * - The oEmbed answer is clamped: only title, author_name and thumbnail_url
 *   are read, text is cleaned and length-capped, and the thumbnail must be an
 *   https URL.
 */
import { isObj, onlyKeys, parseJsonText } from "../ai/validate";
// Type-only: lib/offline/db.ts is a client (Dexie) module, nothing runtime is pulled in.
import type { RoutineRow } from "../offline/db";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Request body byte cap: {"url": "..."} with a 2048-character link. */
export const MAX_BODY_BYTES = 4_096;
/** Longest accepted link. */
export const MAX_URL = 2_048;
/** Largest oEmbed response read (real ones are a few KB). */
export const MAX_RESPONSE_BYTES = 65_536;
/** oEmbed fetch timeout. */
export const FETCH_TIMEOUT_MS = 5_000;
/** Longest title kept. */
export const MAX_TITLE = 200;
/** Longest creator name kept. */
export const MAX_CREATOR = 100;
/** Longest thumbnail URL kept. */
export const MAX_THUMBNAIL_URL = 2_048;
/** Largest TikTok page read when looking for the cover image. */
export const MAX_PAGE_BYTES = 2_097_152;
/** Largest cover image kept (it is stored on the device as a data URL). */
export const MAX_COVER_BYTES = 204_800;

// ---------------------------------------------------------------------------
// Platforms (local copy of RoutineRow["platform"], checked both ways)
// ---------------------------------------------------------------------------

export type Platform = NonNullable<RoutineRow["platform"]>;

export const PLATFORMS = ["tiktok", "instagram", "youtube"] as const satisfies readonly Platform[];

// Compile-time: every RoutineRow platform is in PLATFORMS (the satisfies above checks the other way).
type MissingPlatform = Exclude<Platform, (typeof PLATFORMS)[number]>;
const _allPlatforms: [MissingPlatform] extends [never] ? true : never = true;
void _allPlatforms;

/** Exact hosts accepted. Anything else (including subdomains not listed) is rejected. */
export const ALLOWED_HOSTS: Readonly<Record<string, Platform>> = Object.freeze({
  "tiktok.com": "tiktok",
  "www.tiktok.com": "tiktok",
  "vm.tiktok.com": "tiktok",
  // TikTok's share-sheet short links (SMALL-02).
  "vt.tiktok.com": "tiktok",
  "youtube.com": "youtube",
  "www.youtube.com": "youtube",
  "m.youtube.com": "youtube",
  "youtu.be": "youtube",
  "instagram.com": "instagram",
  "www.instagram.com": "instagram",
});

/** The only URLs the server ever fetches. Instagram has none (needs a Meta token). */
export const OEMBED_ENDPOINTS: Readonly<Partial<Record<Platform, string>>> = Object.freeze({
  tiktok: "https://www.tiktok.com/oembed",
  youtube: "https://www.youtube.com/oembed",
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type ParsedLink = { url: string; platform: Platform };

// Whitespace or control characters anywhere inside the link (after trimming).
const BAD_CHARS = /[\s\u0000-\u001f\u007f-\u009f]/u;

/**
 * The canonical link and its platform, or null unless `raw` is an https link
 * on an exact allow-listed host with no credentials and the default port.
 */
export function parseLink(raw: unknown): ParsedLink | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > MAX_URL || BAD_CHARS.test(s)) return null;
  // Must literally start with https:// (no scheme-relative or odd spellings).
  if (!/^https:\/\//i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port !== "") return null;
  const host = u.hostname.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_HOSTS, host)) return null;
  if (u.href.length > MAX_URL) return null;
  return { url: u.href, platform: ALLOWED_HOSTS[host] };
}

export type ImportBody = { url: string };

/** The request body: exactly { url: string }. Unknown keys are rejected. */
export function validateBody(raw: unknown): ImportBody | null {
  if (!isObj(raw) || !onlyKeys(raw, ["url"])) return null;
  if (typeof raw.url !== "string") return null;
  return { url: raw.url };
}

/** The fixed oEmbed URL for a parsed link, or null when the platform has no public oEmbed. */
export function oembedUrl(link: ParsedLink): string | null {
  const base = OEMBED_ENDPOINTS[link.platform];
  if (!base) return null;
  const q = new URLSearchParams({ url: link.url, format: "json" });
  return `${base}?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type OEmbedDetails = {
  platform: Platform;
  title: string | null;
  thumbnail_url: string | null;
  creator: string | null;
  /** TikTok only: the cover image as a data URL, when oEmbed gave no thumbnail. */
  cover_data_url?: string | null;
};

export type ManualResult = { platform: Platform; manual: true };

export type ImportResult = OEmbedDetails | ManualResult;

/** Clean display text: NFKC, control/format characters removed, whitespace collapsed, capped. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!s) return null;
  // Cut by code point so a surrogate pair is never split.
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : s;
}

/** An https thumbnail URL with no credentials, or null. */
export function cleanThumbnail(v: unknown): string | null {
  if (typeof v !== "string" || !v || v.length > MAX_THUMBNAIL_URL || BAD_CHARS.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  return u.href.length > MAX_THUMBNAIL_URL ? null : u.href;
}

/**
 * Read an oEmbed JSON answer (already parsed). Only title, author_name and
 * thumbnail_url are used. Null when it is not an object or holds none of the
 * three, so the caller answers manual.
 */
export function parseOEmbed(json: unknown, platform: Platform): OEmbedDetails | null {
  if (!isObj(json)) return null;
  const title = cleanText(json.title, MAX_TITLE);
  const creator = cleanText(json.author_name, MAX_CREATOR);
  const thumbnail_url = cleanThumbnail(json.thumbnail_url);
  if (title === null && creator === null && thumbnail_url === null) return null;
  return { platform, title, thumbnail_url, creator };
}

/** parseOEmbed over raw response text; malformed JSON gives null. */
export function parseOEmbedText(text: string, platform: Platform): OEmbedDetails | null {
  return parseOEmbed(parseJsonText(text), platform);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type FetchOptions = { fetchImpl?: FetchLike; timeoutMs?: number; maxBytes?: number };

/** Read a response body with a hard byte cap; null when over the cap or unreadable. */
export async function readCappedBytes(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    reader.cancel().catch(() => {});
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return bytes;
}

/** Read a response body as text with a hard byte cap; null when over the cap or unreadable. */
export async function readCappedText(res: Response, maxBytes: number): Promise<string | null> {
  const bytes = await readCappedBytes(res, maxBytes);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

/**
 * Fetch the fixed oEmbed endpoint for `link` and read it. Null on any failure
 * (no endpoint, network error, timeout, redirect, non-200, non-JSON, oversized
 * or malformed body). Never throws.
 */
export async function fetchOEmbed(link: ParsedLink, opts: FetchOptions = {}): Promise<OEmbedDetails | null> {
  const target = oembedUrl(link);
  if (!target) return null;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(target, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (res.status !== 200 || res.type === "opaqueredirect") {
      res.body?.cancel().catch(() => {});
      return null;
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!/^application\/json(\s*;|$)/.test(type)) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await readCappedText(res, opts.maxBytes ?? MAX_RESPONSE_BYTES);
    if (text === null) return null;
    return parseOEmbedText(text, link.platform);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// TikTok cover image (oEmbed no longer returns a thumbnail)
// ---------------------------------------------------------------------------

/** TikTok's image CDN: signed hosts such as p16-common-sign.tiktokcdn.com. */
const COVER_HOST = /^[a-z0-9-]+\.tiktokcdn(-us)?\.com$/;
const COVER_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** The https cover URL inside a TikTok page's embedded JSON, or null. */
export function parseCoverUrl(html: string): string | null {
  const m = /"cover":("https:[^"]{1,2000}")/.exec(html);
  if (!m) return null;
  let u: URL;
  try {
    u = new URL(JSON.parse(m[1]) as string);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port !== "") return null;
  return COVER_HOST.test(u.hostname) ? u.href : null;
}

async function fetchCapped(url: string, opts: FetchOptions, maxBytes: number, accept: string) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept, "user-agent": "Mozilla/5.0 (compatible; LiftApp)" },
      cache: "no-store",
    });
    if (res.status !== 200 || res.type === "opaqueredirect") {
      res.body?.cancel().catch(() => {});
      return null;
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim();
    const bytes = await readCappedBytes(res, opts.maxBytes ?? maxBytes);
    return bytes ? { type, bytes } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The cover of a TikTok video as a data URL: the link's page is fetched
 * (exact allow-listed host, no redirect), the cover URL is read from it and
 * only a tiktokcdn host is downloaded. TikTok's cover links are signed and
 * expire, so the image itself is kept. Null on any failure. Never throws.
 */
export async function fetchTikTokCover(link: ParsedLink, opts: FetchOptions = {}): Promise<string | null> {
  if (link.platform !== "tiktok") return null;
  const page = await fetchCapped(link.url, opts, MAX_PAGE_BYTES, "text/html");
  if (!page) return null;
  const coverUrl = parseCoverUrl(new TextDecoder().decode(page.bytes));
  if (!coverUrl) return null;
  const img = await fetchCapped(coverUrl, opts, MAX_COVER_BYTES, "image/*");
  if (!img || !COVER_TYPES.has(img.type)) return null;
  return `data:${img.type};base64,${Buffer.from(img.bytes).toString("base64")}`;
}

/** The route's answer for a valid link: details from oEmbed (plus a TikTok cover when it has no thumbnail), or manual. */
export async function importLink(link: ParsedLink, opts: FetchOptions = {}): Promise<ImportResult> {
  const manual: ManualResult = { platform: link.platform, manual: true };
  if (!OEMBED_ENDPOINTS[link.platform]) return manual;
  const details = await fetchOEmbed(link, opts);
  if (link.platform === "tiktok" && !details?.thumbnail_url) {
    const cover = await fetchTikTokCover(link, opts);
    if (cover) return { platform: link.platform, title: null, thumbnail_url: null, creator: null, ...details, cover_data_url: cover };
  }
  return details ?? manual;
}
