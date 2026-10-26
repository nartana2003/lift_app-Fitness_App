/**
 * Server-only pure logic for POST /api/ai/evidence-picks.
 *
 * Goals and up to 6 muscles go in; for each muscle the best catalogue
 * exercises for the goal come out, each with a one or two sentence claim
 * carrying [n] citation markers, plus a numbered list of web sources.
 *
 * Grounding is enforced here, in code:
 * - The call uses Anthropic's server-side web search tool, restricted to the
 *   fixed ALLOWED_DOMAINS list (lib/ai/evidenceDomains.ts) with a low max_uses.
 * - Sources are built ONLY from URLs the search tool returned
 *   (web_search_tool_result blocks and web_search_result_location citations on
 *   text blocks). A URL is https only and must be on the domain table;
 *   publisher and kind come from that table. The quote is the cited text the
 *   API returned for that URL; a source without one cannot be cited.
 * - The model's picks name URLs from its search results; each [n] marker in a
 *   claim must point at one of those, and that URL must be a returned source,
 *   or the whole claim is dropped. The model can never add a URL of its own.
 * - Exercise ids are clamped to the candidates the app offered for that muscle
 *   (catalogue exercises for the muscle that pass the equipment filter).
 * - Search errors (an error object instead of a result list), unusable output
 *   or no surviving pick all fall back to the COACH-01 rule-based suggestions
 *   (lib/coachReview.ts) with source "rules" and no sources at all.
 *
 * Web page text never reaches a prompt: there is one call, its system prompt
 * is fixed text, and the user block holds only validated enums and catalogue
 * fields.
 */
import type { AiContentBlock, AiMessage, AiRequest } from "./client";
import { messageText, webSearchTool } from "./client";
import type { Exercise } from "../exercises";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "../muscles";
import { suggestForMuscle } from "../suggest";
import { reviewSetup } from "../coachReview";
import type { Experience, GoalType } from "../goals";
import { EXPERIENCES, GOAL_TYPES } from "./goal-targets";
import { MAX_NOTE, cleanNote, equipmentOk } from "./generate-routines";
import { equipmentList, escapeForTag, isInt, isMuscle, isObj, onlyKeys, parseJsonText } from "./validate";
import { ALLOWED_DOMAINS, domainFor, type SourceKind } from "./evidenceDomains";
import { loadPrompt } from "../../prompts/load";

// ---------------------------------------------------------------------------
// Limits and fixed text
// ---------------------------------------------------------------------------

export const MAX_BODY_BYTES = 4_096;
export const MAX_MUSCLES = 6;
/** Web searches the model may run per call. */
export const MAX_SEARCHES = 3;
export const MAX_PICKS_PER_MUSCLE = 3;
/** Catalogue exercises offered per muscle. */
export const MAX_CANDIDATES_PER_MUSCLE = 15;
/** Claims longer than this are dropped, not cut (same cap as cleanNote). */
export const MAX_CLAIM = MAX_NOTE;
export const MAX_QUOTE = 300;
export const MAX_TITLE = 200;
export const MAX_URL = 2_048;
/** URLs one pick may list. */
export const MAX_URLS_PER_PICK = 5;

export const EVIDENCE_LEVELS = ["strong", "moderate", "limited", "mixed"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];
const isLevel = (v: unknown): v is EvidenceLevel => typeof v === "string" && (EVIDENCE_LEVELS as readonly string[]).includes(v);

export const DISCLAIMER =
  "General fitness information, not medical advice. Research on the best exercise is limited and findings can conflict.";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type EvidenceGoals = {
  goalType: GoalType;
  experience: Experience;
  sessionsPerWeek: number;
  focusMuscles: MuscleGroup[];
};

export type EvidencePicksInput = {
  goals: EvidenceGoals;
  muscles: MuscleGroup[];
  /** Equipment the user has. Empty means no restriction. */
  equipment: Equipment[];
};

export type ValidateResult = { ok: true; input: EvidencePicksInput } | { ok: false; error: string };

/**
 * Strict shape check of the parsed body. Unknown keys anywhere, unknown enum
 * values, more than MAX_MUSCLES muscles and any free text are rejected.
 * Duplicate muscles, focus muscles and equipment are removed.
 */
export function validateInput(raw: unknown): ValidateResult {
  const bad = (error: string): ValidateResult => ({ ok: false, error });
  if (!isObj(raw) || !onlyKeys(raw, ["goals", "muscles", "equipment"])) return bad("body");

  const g = raw.goals;
  if (!isObj(g) || !onlyKeys(g, ["goalType", "experience", "sessionsPerWeek", "focusMuscles"])) return bad("goals");
  if (typeof g.goalType !== "string" || !(GOAL_TYPES as readonly string[]).includes(g.goalType)) return bad("goals.goalType");
  if (typeof g.experience !== "string" || !(EXPERIENCES as readonly string[]).includes(g.experience)) return bad("goals.experience");
  const sessionsPerWeek = g.sessionsPerWeek ?? 3;
  if (!isInt(sessionsPerWeek, 1, 7)) return bad("goals.sessionsPerWeek");
  const focusMuscles = muscleList(g.focusMuscles, MUSCLE_GROUPS.length);
  if (!focusMuscles) return bad("goals.focusMuscles");

  const muscles = muscleList(raw.muscles, MAX_MUSCLES);
  if (!muscles || muscles.length === 0) return bad("muscles");

  const equipment = equipmentList(raw.equipment ?? []);
  if (!equipment) return bad("equipment");

  return {
    ok: true,
    input: {
      goals: { goalType: g.goalType as GoalType, experience: g.experience as Experience, sessionsPerWeek, focusMuscles },
      muscles,
      equipment,
    },
  };
}

/** Unique muscles, or null when not an array of muscle names or longer than `max` before de-duplication. */
function muscleList(v: unknown, max: number): MuscleGroup[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: MuscleGroup[] = [];
  for (const m of v) {
    if (!isMuscle(m)) return null;
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type EvidenceContext = {
  input: EvidencePicksInput;
  /** Rule-ranked candidates per requested muscle. The model may only pick from these. */
  candidates: Map<MuscleGroup, Exercise[]>;
  catalogue: readonly Exercise[];
};

/** Candidates per muscle: catalogue exercises for it that pass the equipment filter, best first. */
export function buildContext(input: EvidencePicksInput, catalogue: readonly Exercise[]): EvidenceContext {
  const allowed = input.equipment.length ? new Set<Equipment>(input.equipment) : null;
  const usable = catalogue.filter((e) => equipmentOk(e, allowed));
  const candidates = new Map<MuscleGroup, Exercise[]>();
  for (const m of input.muscles) candidates.set(m, suggestForMuscle(usable, m, MAX_CANDIDATES_PER_MUSCLE));
  return { input, candidates, catalogue };
}

export const hasCandidates = (ctx: EvidenceContext) => [...ctx.candidates.values()].some((list) => list.length > 0);

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = loadPrompt("evidence-picks", {
  maxSearches: MAX_SEARCHES,
  maxPicks: MAX_PICKS_PER_MUSCLE,
  maxClaim: MAX_CLAIM,
});

const GOAL_TEXT: Record<GoalType, string> = {
  build_muscle: "build muscle",
  strength: "get stronger",
  general: "general fitness",
  fat_loss: "lose fat",
};

const brief = (e: Exercise) => ({
  id: e.id,
  name: e.name,
  equipment: e.equipment,
  primary: e.muscle_groups,
  secondary: e.secondary_groups,
  mechanic: e.mechanic,
});

/** Data block the model sees: validated enums and catalogue fields only. */
export function promptData(ctx: EvidenceContext) {
  const { goals } = ctx.input;
  return {
    goal: GOAL_TEXT[goals.goalType],
    experience: goals.experience,
    sessions_per_week: goals.sessionsPerWeek,
    focus_muscles: goals.focusMuscles,
    muscles: ctx.input.muscles.map((m) => ({ muscle: m, candidates: (ctx.candidates.get(m) ?? []).map(brief) })),
  };
}

export function buildPrompt(ctx: EvidenceContext): AiRequest {
  const data = escapeForTag(JSON.stringify(promptData(ctx)));
  return {
    system: SYSTEM_PROMPT,
    tools: [webSearchTool(ALLOWED_DOMAINS, MAX_SEARCHES)],
    messages: [
      {
        role: "user",
        content: `<user_data>\n${data}\n</user_data>\n\nSearch for the evidence, then pick the best exercises for each muscle.`,
      },
    ],
    output_config: { effort: "medium" },
  };
}

// ---------------------------------------------------------------------------
// Sources returned by the search tool
// ---------------------------------------------------------------------------

export type FoundSource = {
  url: string;
  title: string;
  publisher: string;
  kind: SourceKind;
  /** Cited text the API returned for this URL; empty when none (then it cannot be cited). */
  quote: string;
};

export type ExtractResult = {
  /** Keyed by normalised URL, in the order first seen. */
  sources: Map<string, FoundSource>;
  /** error_code of a search error result, or null. */
  error: string | null;
};

/**
 * Normalises a URL for comparison: https only, no credentials or port, host on
 * the domain table, no fragment. Null when unusable.
 */
export function normalizeUrl(raw: unknown): { url: string; publisher: string; kind: SourceKind } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const d = domainFor(u.hostname);
  if (!d) return null;
  u.hash = "";
  return { url: u.href, publisher: d.publisher, kind: d.kind };
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max).trimEnd() : s);

/**
 * Collects every usable source from a response's content blocks. Search
 * result blocks give url and title; text-block citations give url, title and
 * the cited text (the quote). Duplicates (after normalising) are merged;
 * non-https or off-list URLs are ignored. A search error result sets `error`.
 */
export function extractSources(content: readonly unknown[]): ExtractResult {
  const sources = new Map<string, FoundSource>();
  let error: string | null = null;

  const add = (rawUrl: unknown, rawTitle: unknown, citedText: unknown) => {
    const n = normalizeUrl(rawUrl);
    if (!n) return;
    const title = clip(cleanNote(rawTitle) ?? "", MAX_TITLE);
    const quote = cleanNote(citedText) ?? "";
    const prev = sources.get(n.url);
    if (!prev) {
      sources.set(n.url, { url: n.url, title, publisher: n.publisher, kind: n.kind, quote: clip(quote, MAX_QUOTE) });
      return;
    }
    if (!prev.title && title) prev.title = title;
    if (quote && !prev.quote.includes(quote)) prev.quote = clip(prev.quote ? `${prev.quote} ... ${quote}` : quote, MAX_QUOTE);
  };

  for (const block of content) {
    if (!isObj(block)) continue;
    if (block.type === "web_search_tool_result") {
      if (Array.isArray(block.content)) {
        for (const r of block.content) if (isObj(r) && r.type === "web_search_result") add(r.url, r.title, null);
      } else {
        const code = isObj(block.content) && typeof block.content.error_code === "string" ? block.content.error_code : "error";
        error ??= /^[a-z_]{1,40}$/.test(code) ? code : "error";
      }
    } else if (block.type === "text" && Array.isArray(block.citations)) {
      for (const c of block.citations) if (isObj(c) && c.type === "web_search_result_location") add(c.url, c.title, c.cited_text);
    }
  }
  return { sources, error };
}

// ---------------------------------------------------------------------------
// Model picks
// ---------------------------------------------------------------------------

export type RawPick = { muscle: MuscleGroup; exercise_id: string; claim: unknown; source_urls: unknown };

export type ParsedPicks = {
  picks: RawPick[];
  evidence: Partial<Record<MuscleGroup, EvidenceLevel>>;
};

/** The last fenced json block of the answer, else the whole text. */
export function extractJsonText(text: string): string {
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\n?([\s\S]*?)```/gi)];
  return fences.length ? fences[fences.length - 1][1] : text;
}

/**
 * Validates and clamps the model's JSON (already parsed). Null when the shape
 * is unusable. Picks keep only requested muscles and that muscle's offered
 * candidates, each exercise once, at most MAX_PICKS_PER_MUSCLE per muscle.
 * Evidence levels outside the enum are dropped. Claims and URLs are checked
 * later by validateCitations.
 */
export function parsePicks(json: unknown, ctx: EvidenceContext): ParsedPicks | null {
  if (!isObj(json) || !Array.isArray(json.picks)) return null;
  const picks: RawPick[] = [];
  const used = new Set<string>();
  for (const p of json.picks as unknown[]) {
    if (!isObj(p) || !isMuscle(p.muscle) || typeof p.exercise_id !== "string") continue;
    const offered = ctx.candidates.get(p.muscle);
    const id = p.exercise_id.trim();
    if (!offered || !offered.some((e) => e.id === id) || used.has(id)) continue;
    if (picks.filter((x) => x.muscle === p.muscle).length >= MAX_PICKS_PER_MUSCLE) continue;
    used.add(id);
    picks.push({ muscle: p.muscle, exercise_id: id, claim: p.claim, source_urls: p.source_urls });
  }
  const evidence: Partial<Record<MuscleGroup, EvidenceLevel>> = {};
  if (isObj(json.evidence)) {
    for (const m of ctx.input.muscles) {
      const v = json.evidence[m];
      if (isLevel(v)) evidence[m] = v;
    }
  }
  return { picks, evidence };
}

/** Parses the model's text answer. Null on invalid JSON or unusable shape. */
export function parsePicksText(text: string, ctx: EvidenceContext): ParsedPicks | null {
  const json = parseJsonText(extractJsonText(text).trim());
  return json === undefined ? null : parsePicks(json, ctx);
}

const MARKER = /\[(\d{1,2})\]/g;
/** Any bracket group holding a digit, e.g. [1, 2] or [3-4]. Only plain [n] is allowed. */
const BRACKET_WITH_DIGIT = /\[[^\]]{0,20}\d[^\]]{0,20}\]/g;
const URL_TEXT = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|gov|int|edu|uk)\b/i;

/**
 * Checks one claim's citations. Every [n] marker must point at the n-th URL
 * of the pick's source_urls, and that URL must be a returned source with a
 * quote; otherwise null (the claim is dropped). A claim with no marker, any
 * other bracketed number, a URL in its text, or longer than MAX_CLAIM is also
 * dropped. On success the markers are renumbered with `idOf` (global source
 * ids, assigned only once the whole claim is known to be valid).
 */
export function validateCitations(
  claim: unknown,
  sourceUrls: unknown,
  sources: ReadonlyMap<string, FoundSource>,
  idOf: (url: string) => number,
): { claim: string; source_ids: number[] } | null {
  if (typeof claim !== "string" || claim.replace(/\s+/g, " ").trim().length > MAX_CLAIM) return null;
  const text = cleanNote(claim);
  if (!text || URL_TEXT.test(text)) return null;
  if (!Array.isArray(sourceUrls) || sourceUrls.length === 0 || sourceUrls.length > MAX_URLS_PER_PICK) return null;

  const markers = [...text.matchAll(MARKER)];
  if (markers.length === 0) return null;
  const strays = (text.match(BRACKET_WITH_DIGIT) ?? []).filter((b) => !/^\[\d{1,2}\]$/.test(b));
  if (strays.length > 0) return null;

  const resolved = new Map<number, string>();
  for (const m of markers) {
    const n = Number(m[1]);
    const url = n >= 1 && n <= sourceUrls.length ? normalizeUrl(sourceUrls[n - 1])?.url : undefined;
    const src = url ? sources.get(url) : undefined;
    if (!url || !src || !src.quote) return null;
    resolved.set(n, url);
  }

  const ids: number[] = [];
  const out = text.replace(MARKER, (_, d: string) => {
    const id = idOf(resolved.get(Number(d))!);
    if (!ids.includes(id)) ids.push(id);
    return `[${id}]`;
  });
  return { claim: out, source_ids: ids };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type EvidencePick = { muscle: MuscleGroup; exercise_id: string; claim: string; source_ids: number[] };

export type EvidenceSource = {
  id: number;
  title: string;
  url: string;
  publisher: string;
  kind: SourceKind;
  quote: string;
};

export type EvidencePicksResult = {
  picks: EvidencePick[];
  sources: EvidenceSource[];
  /** One level per requested muscle. */
  evidence: Partial<Record<MuscleGroup, EvidenceLevel>>;
  disclaimer: string;
  source: "ai" | "rules";
};

/**
 * Builds the final answer from parsed picks and the returned sources. Only
 * cited sources are listed, numbered 1.. in order of first citation. Muscles
 * with no level, or no surviving pick, are "limited" (never overstated: a
 * level the model gave is lowered to "limited" when none of its picks
 * survived). Null when no pick survives.
 */
export function assembleResult(parsed: ParsedPicks, found: ReadonlyMap<string, FoundSource>, ctx: EvidenceContext): EvidencePicksResult | null {
  const ids = new Map<string, number>();
  const idOf = (url: string) => {
    let id = ids.get(url);
    if (id === undefined) {
      id = ids.size + 1;
      ids.set(url, id);
    }
    return id;
  };
  const picks: EvidencePick[] = [];
  for (const p of parsed.picks) {
    const checked = validateCitations(p.claim, p.source_urls, found, idOf);
    if (checked) picks.push({ muscle: p.muscle, exercise_id: p.exercise_id, ...checked });
  }
  if (picks.length === 0) return null;

  const sources: EvidenceSource[] = [...ids].map(([url, id]) => {
    const s = found.get(url)!;
    return { id, title: s.title || s.publisher, url: s.url, publisher: s.publisher, kind: s.kind, quote: s.quote };
  });
  const evidence: Partial<Record<MuscleGroup, EvidenceLevel>> = {};
  for (const m of ctx.input.muscles) {
    const given = parsed.evidence[m];
    evidence[m] = given && picks.some((p) => p.muscle === m) ? given : "limited";
  }
  return { picks, sources, evidence, disclaimer: DISCLAIMER, source: "ai" };
}

/**
 * The COACH-01 rule-based suggestions (reviewSetup on a one-day split of the
 * requested muscles with an empty pool): no citations, no sources, every
 * muscle "limited".
 */
export function ruleEvidence(ctx: EvidenceContext): EvidencePicksResult {
  const { goals, muscles, equipment } = ctx.input;
  const review = reviewSetup({
    goals: { ...goals, focusMuscles: goals.focusMuscles.filter((m) => muscles.includes(m)) },
    split: { name: "Evidence", days: [{ name: "Evidence", muscles }] },
    pool: {},
    catalogue: ctx.catalogue,
    equipment,
  });
  const picks: EvidencePick[] = review.suggestions
    .filter((s) => muscles.includes(s.muscle))
    .map((s) => ({ muscle: s.muscle, exercise_id: s.exercise_id, claim: s.reason, source_ids: [] }));
  const evidence: Partial<Record<MuscleGroup, EvidenceLevel>> = {};
  for (const m of muscles) evidence[m] = "limited";
  return { picks, sources: [], evidence, disclaimer: DISCLAIMER, source: "rules" };
}

/**
 * The whole response path: a search error, unusable output or no surviving
 * pick gives the rule-based answer.
 */
export function evidenceFromMessage(message: Pick<AiMessage, "content">, ctx: EvidenceContext): EvidencePicksResult {
  const found = extractSources(message.content as readonly AiContentBlock[] as readonly unknown[]);
  if (found.error) return ruleEvidence(ctx);
  const parsed = parsePicksText(messageText(message as AiMessage), ctx);
  if (!parsed) return ruleEvidence(ctx);
  return assembleResult(parsed, found.sources, ctx) ?? ruleEvidence(ctx);
}
