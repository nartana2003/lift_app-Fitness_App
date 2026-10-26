/**
 * Server-only pure logic for POST /api/ai/photo-analysis (PLAN.md:208).
 *
 * The month's first and last progress photos (Claude vision) plus the month's
 * training stats go in; a short progress comment and up to MAX_FOCUS focus
 * tips come out.
 *
 * Safety:
 * - No free text is accepted. Every field is a number, a fixed-enum string
 *   (unit, pose, media type, muscle group) or a date. Lists are capped.
 * - Images: at most MAX_PHOTOS, only ALLOWED_MEDIA_TYPES (JPEG, PNG). The
 *   base64 is checked strictly (alphabet, padding, canonical form) and its
 *   length is capped before it is decoded; each decoded image and the decoded
 *   total have hard byte caps; the bytes must match the declared type by
 *   signature and parse as a well-formed JPEG or PNG with sane dimensions.
 *   Metadata (EXIF, XMP, IPTC, comments, text chunks, trailing data) is
 *   stripped before anything is sent to the model, so location or device data
 *   in a photo never leaves the server.
 * - No image bytes, base64 or metadata ever appear in a response or an error:
 *   the result is built only from the cleaned model text and the stats, and
 *   errors are the shared fixed shapes.
 * - Non-image data reaches the prompt JSON-encoded and escaped inside one
 *   <user_data> block. The system prompt says that block and any text visible
 *   in the photos are data, never instructions.
 * - The model's answer is clamped: at most MAX_COMMENT_LINES sentences and
 *   MAX_FOCUS tips, cleaned with cleanNote and length-capped; a tip's muscle
 *   must be one of MUSCLE_GROUPS or null, else the tip is dropped.
 *
 * rulePhotoAnalysis() builds the same result shape from the stats with no
 * model, so the feature works without AI.
 */
import type { AiRequest } from "./client";
import { MUSCLE_GROUPS, type MuscleGroup } from "../muscles";
import type { PhotoRow } from "../offline/db";
import { formatDuration } from "../stats";
import { dispNum, fmtVolume, type Unit } from "../units";
import { cleanNote } from "./generate-routines";
import { MAX_DURATION_SEC, MAX_MUSCLE_SETS, MAX_SESSIONS, MAX_VOLUME } from "./summary";
import { escapeForTag, isDateKey, isInt, isMuscle, isNum, isObj, onlyKeys, parseJsonText } from "./validate";
import { loadPrompt } from "../../prompts/load";

/** Content block types derived from AiRequest, so the SDK is only imported by lib/ai/client.ts. */
type ContentBlock = Exclude<AiRequest["messages"][number]["content"], string>[number];
type ImageBlock = Extract<ContentBlock, { type: "image" }>;
type ImageMediaType = Extract<ImageBlock["source"], { type: "base64" }>["media_type"];

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** First and last photo of the month. */
export const MAX_PHOTOS = 2;
/** JPEG (what PhotosTab stores) and PNG only; both are Claude vision types. */
export const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png"] as const satisfies readonly ImageMediaType[];
export type PhotoMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];
/** Hard cap on one decoded image. PhotosTab stores <=1280px JPEGs, well under this. */
export const MAX_IMAGE_BYTES = 1_500_000;
/** Hard cap on all decoded images together. */
export const MAX_TOTAL_IMAGE_BYTES = 2_500_000;
/** Smaller than this cannot be a real photo. */
export const MIN_IMAGE_BYTES = 32;
/** Longest edge accepted (the API's own limit is 8000px). */
export const MAX_DIMENSION = 8000;

/** Base64 length of n bytes (with padding). */
export const base64Len = (n: number) => 4 * Math.ceil(n / 3);
/** Longest base64 string accepted for one image, checked before decoding. */
export const MAX_IMAGE_B64 = base64Len(MAX_IMAGE_BYTES);
/** Request body cap for readJsonBody: all images at the total cap plus room for the stats. */
export const MAX_BODY_BYTES = base64Len(MAX_TOTAL_IMAGE_BYTES) + 16_384;

export const UNITS = ["kg", "lb"] as const satisfies readonly Unit[];
/**
 * Same values as PhotoRow["pose"] in lib/offline/db.ts (client-only, so only
 * the type is imported). `satisfies` fails if this list has a value the type
 * lacks, and POSES_COMPLETE fails if the type gains a value this list lacks.
 */
export const POSES = ["front", "side", "back"] as const satisfies readonly NonNullable<PhotoRow["pose"]>[];
type Pose = (typeof POSES)[number];
const POSES_COMPLETE: [Exclude<NonNullable<PhotoRow["pose"]>, Pose>] extends [never] ? true : never = true;
void POSES_COMPLETE;

export const MAX_PR_COUNT = 100;
export const MIN_BODYWEIGHT = 20;
export const MAX_BODYWEIGHT = 400;

export const MAX_COMMENT_LINES = 4;
export const MAX_COMMENT_LINE = 240;
export const MAX_FOCUS = 3;
export const MAX_FOCUS_TEXT = 200;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type PhotoInput = {
  taken_on: string;
  pose: Pose | null;
  media_type: PhotoMediaType;
  /** Canonical base64 of the image with metadata stripped. Never returned to the client. */
  data: string;
  width: number;
  height: number;
};

export type MonthStats = {
  sessions: number;
  duration_sec: number;
  /** kg */
  volume: number;
  sets_by_muscle: Partial<Record<MuscleGroup, number>>;
  pr_count: number;
  /** kg, first and last bodyweight entry of the month, or null. */
  bodyweight_start: number | null;
  bodyweight_end: number | null;
};

export type PhotoAnalysisInput = {
  /** YYYY-MM */
  month: string;
  unit: Unit;
  /** 1..MAX_PHOTOS, oldest first. */
  photos: PhotoInput[];
  stats: MonthStats;
};

export type ValidateResult = { ok: true; input: PhotoAnalysisInput } | { ok: false; error: string };

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const isUnit = (v: unknown): v is Unit => typeof v === "string" && (UNITS as readonly string[]).includes(v);
const isPose = (v: unknown): v is Pose => typeof v === "string" && (POSES as readonly string[]).includes(v);
export const isMediaType = (v: unknown): v is PhotoMediaType => typeof v === "string" && (ALLOWED_MEDIA_TYPES as readonly string[]).includes(v);

/**
 * Strict base64 decode. Null unless `v` is a non-empty string of at most
 * `maxLen` characters in the standard alphabet, padded to a multiple of 4,
 * and in canonical form (re-encoding gives the same string back). The length
 * is checked before anything is decoded.
 */
export function decodeBase64(v: unknown, maxLen: number): Uint8Array | null {
  if (typeof v !== "string" || v.length === 0 || v.length > maxLen || v.length % 4 !== 0) return null;
  if (!B64_RE.test(v)) return null;
  const buf = Buffer.from(v, "base64");
  if (buf.toString("base64") !== v) return null;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export const encodeBase64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/** The image type the bytes' signature says, or null. */
export function sniffMediaType(b: Uint8Array): PhotoMediaType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((x, i) => b[i] === x)) return "image/png";
  return null;
}

export type CleanImage = { bytes: Uint8Array; width: number; height: number };

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const startsWithAscii = (b: Uint8Array, at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));

/** Frame headers kept: SOF0-3, SOF5-7, SOF9-11, SOF13-15 (not DHT C4, JPG C8 or DAC CC). */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** Table and misc segments kept as they are: DHT, DAC, DQT, DNL, DRI. */
const JPEG_TABLES = new Set([0xc4, 0xcc, 0xdb, 0xdc, 0xdd]);
const isRst = (m: number) => m >= 0xd0 && m <= 0xd7;
/** Metadata segments that are recognised and dropped: APP0-15 and COM. */
const isJpegMeta = (m: number) => (m >= 0xe0 && m <= 0xef) || m === 0xfe;

/**
 * Whether an APPn segment (marker `m`, payload from `at`, `n` payload bytes)
 * is one of the three kept for display: APP0 JFIF with no thumbnail (exactly
 * "JFIF\0" + 9 header bytes), APP2 ICC profile, APP14 Adobe colour transform
 * (exactly "Adobe" + 7 bytes).
 */
function keepJpegApp(b: Uint8Array, m: number, at: number, n: number): boolean {
  if (m === 0xe0) return n === 14 && startsWithAscii(b, at, "JFIF\0") && b[at + 12] === 0 && b[at + 13] === 0;
  if (m === 0xe2) return n > 14 && startsWithAscii(b, at, "ICC_PROFILE\0");
  if (m === 0xee) return n === 12 && startsWithAscii(b, at, "Adobe");
  return false;
}

/**
 * Rebuild a JPEG keeping only what is needed to show it. This is an ALLOW
 * list: the frame header (one SOF), DHT, DAC, DQT, DNL, DRI, SOS headers with
 * their entropy-coded scan data (with its stuffed bytes and RSTn), plus APP0 JFIF (no thumbnail), APP2
 * ICC profile and APP14 Adobe. Every other APPn (EXIF, XMP, IPTC, JFXX
 * thumbnails, ...) and COM is dropped wherever it appears, including between
 * the scans of a progressive JPEG. Any other marker (JPGn, reserved, TEM,
 * hierarchical DHP/EXP, RSTn outside a scan, a second SOF or SOI) makes the whole image rejected,
 * as does a malformed length, a missing frame header, a missing scan or EOI,
 * or a size out of range. Anything after EOI is dropped.
 *
 * Every step moves `pos` or `i` forward, so the walk is linear in the input.
 */
export function stripJpeg(b: Uint8Array): CleanImage | null {
  if (sniffMediaType(b) !== "image/jpeg") return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let pos = 2;
  let width = 0;
  let height = 0;
  let scans = 0;
  for (;;) {
    if (pos + 1 >= b.length || b[pos] !== 0xff) return null;
    // Fill bytes before a marker.
    while (pos + 1 < b.length && b[pos + 1] === 0xff) pos++;
    if (pos + 1 >= b.length) return null;
    const m = b[pos + 1];
    if (m === 0xd9) {
      if (!scans) return null;
      parts.push(b.subarray(pos, pos + 2));
      return { bytes: concat(parts), width, height };
    }
    // RSTn is only valid inside scan data, which the SOS walk below handles,
    // so one here (outside a scan, or after fill bytes) is not recognised.
    const known = JPEG_SOF.has(m) || JPEG_TABLES.has(m) || m === 0xda || isJpegMeta(m);
    if (!known) return null;
    if (pos + 4 > b.length) return null;
    const len = (b[pos + 2] << 8) | b[pos + 3];
    const end = pos + 2 + len;
    if (len < 2 || end > b.length) return null;
    const at = pos + 4;
    const n = len - 2;

    if (isJpegMeta(m)) {
      if (m !== 0xfe && keepJpegApp(b, m, at, n)) parts.push(b.subarray(pos, end));
      pos = end;
      continue;
    }

    if (JPEG_SOF.has(m)) {
      if (width || scans) return null; // one frame only, before any scan
      const comps = b[at + 5];
      if (n < 6 || !comps || n !== 6 + 3 * comps) return null;
      height = (b[at + 1] << 8) | b[at + 2];
      width = (b[at + 3] << 8) | b[at + 4];
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
      parts.push(b.subarray(pos, end));
      pos = end;
      continue;
    }

    if (JPEG_TABLES.has(m)) {
      parts.push(b.subarray(pos, end));
      pos = end;
      continue;
    }

    // SOS: header, then entropy-coded data. Inside that data 0xFF is followed
    // by 0x00 (stuffed byte) or RSTn; any other marker ends the scan and goes
    // back through the marker rules above, so APPn/COM between scans are
    // dropped like anywhere else.
    if (!width || !height) return null;
    const ns = b[at];
    if (!ns || ns > 4 || n !== 4 + 2 * ns) return null;
    let i = end;
    for (;;) {
      if (i + 1 >= b.length) return null; // scan never ended
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const next = b[i + 1];
      if (next === 0x00 || isRst(next)) {
        i += 2;
        continue;
      }
      break; // a marker (possibly after fill bytes) at i
    }
    parts.push(b.subarray(pos, i));
    scans++;
    pos = i;
  }
}

/** PNG chunks kept: the critical ones and colour/geometry ancillaries. Text, eXIf, tIME, APNG and unknown chunks are dropped. */
const PNG_CRITICAL = ["IHDR", "PLTE", "IDAT", "IEND"];
const PNG_KEEP = [...PNG_CRITICAL, "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "bKGD", "pHYs"];

/**
 * Rebuild a PNG keeping only image chunks (see PNG_KEEP) up to IEND. Null when
 * the structure is malformed, IHDR is not first or has invalid fields, an
 * unknown critical chunk is present, there is no IDAT, IEND is missing or the
 * size is out of range.
 */
export function stripPng(b: Uint8Array): CleanImage | null {
  if (sniffMediaType(b) !== "image/png") return null;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let pos = 8;
  let width = 0;
  let height = 0;
  let first = true;
  let idat = false;
  for (;;) {
    if (pos + 12 > b.length) return null;
    const len = ((b[pos] << 24) >>> 0) + (b[pos + 1] << 16) + (b[pos + 2] << 8) + b[pos + 3];
    // The PNG spec caps chunk lengths at 2^31 - 1.
    if (len > 0x7fffffff) return null;
    const end = pos + 12 + len;
    if (end > b.length) return null;
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    if (first) {
      if (type !== "IHDR" || len !== 13) return null;
      width = ((b[pos + 8] << 24) >>> 0) + (b[pos + 9] << 16) + (b[pos + 10] << 8) + b[pos + 11];
      height = ((b[pos + 12] << 24) >>> 0) + (b[pos + 13] << 16) + (b[pos + 14] << 8) + b[pos + 15];
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
      // Colour type, compression, filter and interlace must be values the spec defines.
      if (![0, 2, 3, 4, 6].includes(b[pos + 17]) || b[pos + 18] !== 0 || b[pos + 19] !== 0 || b[pos + 20] > 1) return null;
      first = false;
    } else if (type === "IHDR") {
      return null;
    }
    const critical = type[0] >= "A" && type[0] <= "Z";
    if (critical && !PNG_CRITICAL.includes(type)) return null;
    if (type === "IDAT") idat = true;
    if (PNG_KEEP.includes(type)) parts.push(b.subarray(pos, end));
    if (type === "IEND") return idat ? { bytes: concat(parts), width, height } : null;
    pos = end;
  }
}

/**
 * Decode and clean one image. Null on any problem: bad base64, too small or
 * too large, a signature that does not match `mediaType`, malformed structure
 * or out-of-range dimensions.
 */
export function cleanImage(mediaType: PhotoMediaType, data: unknown): (CleanImage & { received: number }) | null {
  const bytes = decodeBase64(data, MAX_IMAGE_B64);
  if (!bytes || bytes.length < MIN_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) return null;
  if (sniffMediaType(bytes) !== mediaType) return null;
  const img = mediaType === "image/jpeg" ? stripJpeg(bytes) : stripPng(bytes);
  return img && { ...img, received: bytes.length };
}

const STATS_KEYS = ["sessions", "duration_sec", "volume", "sets_by_muscle", "pr_count", "bodyweight_start", "bodyweight_end"] as const;

function validateStats(raw: unknown): MonthStats | string {
  if (!isObj(raw) || !onlyKeys(raw, STATS_KEYS)) return "stats";
  if (!isInt(raw.sessions, 0, MAX_SESSIONS)) return "sessions";
  if (!isInt(raw.duration_sec, 0, MAX_DURATION_SEC)) return "duration_sec";
  if (!isNum(raw.volume, 0, MAX_VOLUME)) return "volume";
  if (!isObj(raw.sets_by_muscle)) return "sets_by_muscle";
  const sets_by_muscle: Partial<Record<MuscleGroup, number>> = {};
  for (const [k, n] of Object.entries(raw.sets_by_muscle)) {
    if (!isMuscle(k) || !isInt(n, 0, MAX_MUSCLE_SETS)) return "sets_by_muscle";
    sets_by_muscle[k] = n;
  }
  if (raw.pr_count !== undefined && !isInt(raw.pr_count, 0, MAX_PR_COUNT)) return "pr_count";
  const bw = (v: unknown): number | null | undefined =>
    v === undefined || v === null ? null : isNum(v, MIN_BODYWEIGHT, MAX_BODYWEIGHT) ? v : undefined;
  const bodyweight_start = bw(raw.bodyweight_start);
  const bodyweight_end = bw(raw.bodyweight_end);
  if (bodyweight_start === undefined) return "bodyweight_start";
  if (bodyweight_end === undefined) return "bodyweight_end";
  return {
    sessions: raw.sessions,
    duration_sec: raw.duration_sec,
    volume: raw.volume,
    sets_by_muscle,
    pr_count: (raw.pr_count as number | undefined) ?? 0,
    bodyweight_start,
    bodyweight_end,
  };
}

/**
 * Strict shape check of the request body (already JSON-parsed). Unknown keys,
 * wrong types, out-of-range numbers, unknown enum values, dates outside the
 * month or out of order, too many photos and any image problem are all
 * rejected. Error codes are field names only; they never contain input data.
 */
export function validateInput(raw: unknown): ValidateResult {
  const bad = (error: string): ValidateResult => ({ ok: false, error });
  if (!isObj(raw) || !onlyKeys(raw, ["month", "unit", "photos", "stats"])) return bad("body");
  if (typeof raw.month !== "string" || !MONTH_RE.test(raw.month)) return bad("month");
  const month = raw.month;
  if (raw.unit !== undefined && !isUnit(raw.unit)) return bad("unit");
  const unit: Unit = raw.unit ?? "kg";

  const stats = validateStats(raw.stats);
  if (typeof stats === "string") return bad(`stats.${stats}`);

  if (!Array.isArray(raw.photos) || raw.photos.length < 1 || raw.photos.length > MAX_PHOTOS) return bad("photos");
  // Cheap checks on every photo first, so no image is decoded for a body that fails them.
  for (const p of raw.photos as unknown[]) {
    if (!isObj(p) || !onlyKeys(p, ["taken_on", "pose", "media_type", "data"])) return bad("photos");
    if (!isDateKey(p.taken_on) || !p.taken_on.startsWith(`${month}-`)) return bad("photos.taken_on");
    if (p.pose !== undefined && p.pose !== null && !isPose(p.pose)) return bad("photos.pose");
    if (!isMediaType(p.media_type)) return bad("photos.media_type");
    if (typeof p.data !== "string" || p.data.length > MAX_IMAGE_B64) return bad("photos.data");
  }
  const list = raw.photos as Record<string, unknown>[];
  for (let i = 1; i < list.length; i++) {
    if ((list[i].taken_on as string) < (list[i - 1].taken_on as string)) return bad("photos.order");
  }

  const photos: PhotoInput[] = [];
  let total = 0;
  for (const p of list) {
    const media_type = p.media_type as PhotoMediaType;
    const img = cleanImage(media_type, p.data);
    if (!img) return bad("photos.data");
    // The total cap counts the bytes as received, before metadata is stripped.
    total += img.received;
    if (total > MAX_TOTAL_IMAGE_BYTES) return bad("photos.total");
    photos.push({
      taken_on: p.taken_on as string,
      pose: (p.pose as Pose | null | undefined) ?? null,
      media_type,
      data: encodeBase64(img.bytes),
      width: img.width,
      height: img.height,
    });
  }

  return { ok: true, input: { month, unit, photos, stats } };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type PhotoSource = "ai" | "rule";

export type FocusTip = {
  /** One of MUSCLE_GROUPS, or null for a general tip. */
  muscle: MuscleGroup | null;
  text: string;
  source: PhotoSource;
};

export type PhotoAnalysisResult = {
  month: string;
  /** 1..MAX_COMMENT_LINES short plain sentences. */
  comment: string[];
  comment_source: PhotoSource;
  /** 0..MAX_FOCUS tips. */
  focus: FocusTip[];
  /** Model items dropped or changed, plus rule-based fills. */
  adjusted: number;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Plain comment sentences from the stats and photo dates, no model. */
export function ruleComment(input: PhotoAnalysisInput): string[] {
  const { month, unit, stats: s, photos } = input;
  const lines: string[] = [];
  if (s.sessions === 0) {
    lines.push(`No workouts logged in ${monthLabel(month)}.`);
  } else {
    lines.push(
      `${monthLabel(month)}: ${plural(s.sessions, "session")}, ${formatDuration(s.duration_sec)} of training and ${fmtVolume(s.volume, unit)} total volume.`,
    );
  }
  const trained = MUSCLE_GROUPS.map((m) => ({ m, n: s.sets_by_muscle[m] ?? 0 })).filter((x) => x.n > 0);
  if (trained.length) {
    const top = [...trained].sort((a, b) => b.n - a.n || MUSCLE_GROUPS.indexOf(a.m) - MUSCLE_GROUPS.indexOf(b.m))[0];
    const prs = s.pr_count ? ` and ${plural(s.pr_count, "personal record")}` : "";
    lines.push(`Most sets went to ${top.m} (${top.n})${prs}.`);
  }
  if (s.bodyweight_start !== null && s.bodyweight_end !== null) {
    const a = dispNum(s.bodyweight_start, unit);
    const b = dispNum(s.bodyweight_end, unit);
    const d = Math.round((b - a) * 10) / 10;
    lines.push(d === 0 ? `Bodyweight held at ${b}${unit}.` : `Bodyweight went from ${a}${unit} to ${b}${unit}.`);
  }
  if (photos.length >= 2) {
    const days = dayDiff(photos[0].taken_on, photos[photos.length - 1].taken_on);
    lines.push(`Your first and last photos are ${plural(days, "day")} apart. Compare them side by side to see the change.`);
  } else {
    lines.push("Add a second photo at the end of the month to compare.");
  }
  return lines.slice(0, MAX_COMMENT_LINES);
}

/** Rule-based focus tips: the least-trained trained muscle, then a photo habit tip. */
export function ruleFocus(input: PhotoAnalysisInput): FocusTip[] {
  const out: FocusTip[] = [];
  const trained = MUSCLE_GROUPS.map((m) => ({ m, n: input.stats.sets_by_muscle[m] ?? 0 })).filter((x) => x.n > 0);
  if (trained.length >= 2) {
    const low = [...trained].sort((a, b) => a.n - b.n || MUSCLE_GROUPS.indexOf(a.m) - MUSCLE_GROUPS.indexOf(b.m))[0];
    out.push({ muscle: low.m, text: `${low.m} got the fewest sets (${low.n}). Add a set or two next month if it is a priority.`, source: "rule" });
  }
  out.push({ muscle: null, text: "Take next month's photos in the same light, pose and time of day so they compare fairly.", source: "rule" });
  return out.slice(0, MAX_FOCUS);
}

/** The whole analysis from rules only (no model). */
export function rulePhotoAnalysis(input: PhotoAnalysisInput): PhotoAnalysisResult {
  return { month: input.month, comment: ruleComment(input), comment_source: "rule", focus: ruleFocus(input), adjusted: 0 };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = loadPrompt("photo-analysis", { maxCommentLines: MAX_COMMENT_LINES, maxFocus: MAX_FOCUS, maxFocusText: MAX_FOCUS_TEXT });

/** JSON schema for structured output. Counts, lengths and muscles are enforced again in parseResponse. */
export const PHOTO_SCHEMA = {
  type: "object",
  properties: {
    comment: { type: "array", items: { type: "string" } },
    focus: {
      type: "array",
      items: {
        type: "object",
        properties: {
          muscle: { anyOf: [{ type: "string" }, { type: "null" }] },
          text: { type: "string" },
        },
        required: ["muscle", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["comment", "focus"],
  additionalProperties: false,
} as const;

/** Data block the model sees. Only validated values; never image bytes. */
export function promptData(input: PhotoAnalysisInput) {
  const { month, unit, stats: s } = input;
  return {
    month,
    unit,
    photos: input.photos.map((p, i) => ({ photo: i + 1, taken_on: p.taken_on, pose: p.pose })),
    stats: {
      sessions: s.sessions,
      duration_min: Math.round(s.duration_sec / 60),
      volume: dispNum(s.volume, unit),
      sets_by_muscle: Object.fromEntries(MUSCLE_GROUPS.filter((m) => s.sets_by_muscle[m] !== undefined).map((m) => [m, s.sets_by_muscle[m]])),
      personal_records: s.pr_count,
      bodyweight_start: s.bodyweight_start === null ? null : dispNum(s.bodyweight_start, unit),
      bodyweight_end: s.bodyweight_end === null ? null : dispNum(s.bodyweight_end, unit),
    },
  };
}

/**
 * The request: one text block with the fenced data, then each photo after a
 * fixed label, then the fixed task. A photo whose media type is not allowed
 * (only possible if validation were bypassed) is left out.
 */
export function buildPrompt(input: PhotoAnalysisInput): AiRequest {
  const data = escapeForTag(JSON.stringify(promptData(input)));
  const content: ContentBlock[] = [{ type: "text", text: `<user_data>\n${data}\n</user_data>` }];
  input.photos.forEach((p, i) => {
    if (!isMediaType(p.media_type)) return;
    const which = i === 0 ? "first" : "last";
    content.push({ type: "text", text: `Photo ${i + 1} (${which} of the month):` });
    content.push({ type: "image", source: { type: "base64", media_type: p.media_type, data: p.data } });
  });
  content.push({ type: "text", text: "Write the monthly progress comment and the focus tips." });
  return {
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    output_config: { effort: "low", format: { type: "json_schema", schema: PHOTO_SCHEMA as unknown as Record<string, unknown> } },
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** Plain short text via cleanNote (no emojis, no control characters), capped at `max`. */
export function cleanText(v: unknown, max: number): string | null {
  const s = cleanNote(v);
  return s ? s.slice(0, max).trim() || null : null;
}

/**
 * Validates and clamps the model's JSON. Null when the shape is unusable (not
 * an object with comment and focus arrays). Otherwise lines and tips are
 * cleaned and capped, a tip with a muscle outside MUSCLE_GROUPS is dropped,
 * duplicates are dropped, and an empty comment or focus list is filled from
 * the rule-based analysis.
 */
export function parseResponse(json: unknown, input: PhotoAnalysisInput): PhotoAnalysisResult | null {
  if (!isObj(json) || !Array.isArray(json.comment) || !Array.isArray(json.focus)) return null;
  let adjusted = 0;

  const comment: string[] = [];
  for (const line of json.comment as unknown[]) {
    const s = cleanText(line, MAX_COMMENT_LINE);
    if (!s || comment.length >= MAX_COMMENT_LINES || comment.includes(s)) {
      adjusted++;
      continue;
    }
    if (s !== line) adjusted++;
    comment.push(s);
  }

  const focus: FocusTip[] = [];
  for (const item of json.focus as unknown[]) {
    if (!isObj(item) || focus.length >= MAX_FOCUS) {
      adjusted++;
      continue;
    }
    const muscle = item.muscle ?? null;
    if (muscle !== null && !isMuscle(muscle)) {
      adjusted++;
      continue;
    }
    const text = cleanText(item.text, MAX_FOCUS_TEXT);
    if (!text || focus.some((f) => f.text === text)) {
      adjusted++;
      continue;
    }
    if (text !== item.text) adjusted++;
    focus.push({ muscle, text, source: "ai" });
  }

  let comment_source: PhotoSource = "ai";
  let lines = comment;
  if (lines.length === 0) {
    lines = ruleComment(input);
    comment_source = "rule";
    adjusted++;
  }
  if (focus.length === 0) {
    const fills = ruleFocus(input);
    adjusted += fills.length;
    focus.push(...fills);
  }

  return { month: input.month, comment: lines, comment_source, focus, adjusted };
}

/** Parses the model's text, then clamps it. Null on invalid JSON or unusable shape. */
export function parseResponseText(text: string, input: PhotoAnalysisInput): PhotoAnalysisResult | null {
  const json = parseJsonText(text);
  return json === undefined ? null : parseResponse(json, input);
}
