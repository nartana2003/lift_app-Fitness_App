/**
 * Server-only pure logic for POST /api/ai/swap-exercise.
 *
 * An exercise (catalogue id), why it is being swapped (one of lib/swap.ts
 * SwapReason) and, optionally, the user's equipment and the ids already in the
 * workout go in; ranked catalogue alternatives, each with a short reason, come
 * out.
 *
 * Candidates come from the existing rule ranking, swapOptions() in
 * lib/swap.ts (no second copy of the scoring), run over the catalogue after:
 * - removing exercises the user's equipment cannot do (Bodyweight is always allowed),
 * - removing ids the client says are already in the workout,
 * - for reason "equipment", removing exercises that need the same equipment
 *   as the one being swapped (the user does not have it), unless that is Bodyweight.
 * The model only re-ranks and explains those candidates. Every model pick is
 * clamped to the candidate list (unknown, invented, excluded or duplicate ids
 * are dropped), reasons are cleaned, and whatever is left is topped up in rule
 * order, so ruleSwap() gives the same shape with no model at all.
 *
 * No free text is accepted: the exercise and excluded ids must be catalogue
 * ids, the reason and equipment are enum values. All data reaches the prompt
 * JSON-encoded inside one <user_data> block that the system prompt declares to
 * be data only.
 */
import type { AiRequest } from "./client";
import type { Exercise } from "../exercises";
import type { Equipment } from "../muscles";
import { SWAP_REASONS, swapOptions, type SwapReason } from "../swap";
import { cleanNote, equipmentOk } from "./generate-routines";
import { equipmentList, escapeForTag, isObj, onlyKeys, parseJsonText } from "./validate";
import { loadPrompt } from "../../prompts/load";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_BODY_BYTES = 8_192;
/** Alternatives returned (the swap sheet shows 6). */
export const MAX_ALTERNATIVES = 6;
/** Catalogue exercises offered to the model to rank. */
export const MAX_CANDIDATES = 24;
/** Most ids the client may list as already in the workout. */
export const MAX_EXCLUDE = 40;
/** Longest catalogue id accepted (real ids are well under this). */
export const MAX_ID_LENGTH = 120;
export const MAX_REASON = 200;

/** Swap reasons, in lib/swap.ts order. */
export const REASONS: readonly SwapReason[] = SWAP_REASONS.map((r) => r.v);

/** What each reason asks of the alternatives. Fixed text, sent as data. */
export const REASON_DETAIL: Record<SwapReason, string> = {
  busy: "The equipment for this exercise is taken right now. Prefer alternatives on different equipment that can be done now.",
  equipment: "The user does not have the equipment for this exercise. Prefer alternatives needing little or no equipment.",
  hurts: "This exercise is uncomfortable for the user today. Prefer controlled, joint-friendly alternatives such as machines or cables. Give no medical advice.",
  variety: "The user wants a different exercise for the same muscles.",
};

const isReason = (v: unknown): v is SwapReason => typeof v === "string" && (REASONS as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type SwapExerciseInput = {
  /** Catalogue id of the exercise being swapped. */
  exercise_id: string;
  reason: SwapReason;
  /** Equipment the user has. Empty means "no restriction". */
  equipment: Equipment[];
  /** Catalogue ids already in the workout; never suggested. */
  exclude: string[];
};

export type ValidateResult = { ok: true; input: SwapExerciseInput } | { ok: false; error: string };

const isCatalogueId = (v: unknown, byId: ReadonlyMap<string, Exercise>): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH && byId.has(v);

/**
 * Strict shape check of the request body (already JSON-parsed). Unknown keys,
 * ids not in the catalogue, unknown reasons or equipment and oversized lists
 * are rejected. Duplicate equipment and exclude ids are removed.
 */
export function validateInput(raw: unknown, byId: ReadonlyMap<string, Exercise>): ValidateResult {
  const bad = (error: string): ValidateResult => ({ ok: false, error });
  if (!isObj(raw) || !onlyKeys(raw, ["exercise_id", "reason", "equipment", "exclude"])) return bad("body");
  if (!isCatalogueId(raw.exercise_id, byId)) return bad("exercise_id");
  if (!isReason(raw.reason)) return bad("reason");

  const equipment = equipmentList(raw.equipment ?? []);
  if (!equipment) return bad("equipment");

  const rawExclude = raw.exclude ?? [];
  if (!Array.isArray(rawExclude) || rawExclude.length > MAX_EXCLUDE) return bad("exclude");
  const exclude: string[] = [];
  for (const id of rawExclude) {
    if (!isCatalogueId(id, byId)) return bad("exclude");
    if (!exclude.includes(id)) exclude.push(id);
  }

  return { ok: true, input: { exercise_id: raw.exercise_id, reason: raw.reason, equipment, exclude } };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type SwapContext = {
  target: Exercise;
  reason: SwapReason;
  /** Null means every equipment type is allowed. */
  allowed: Set<Equipment> | null;
  /** Rule-ranked alternatives (swapOptions), best first. The model may only pick from these. */
  candidates: Exercise[];
};

/**
 * Builds the candidate list. Returns null when the exercise is not in the
 * catalogue (validateInput already rejects that; this guards direct callers).
 */
export function buildContext(input: SwapExerciseInput, catalogue: Exercise[]): SwapContext | null {
  const target = catalogue.find((e) => e.id === input.exercise_id);
  if (!target) return null;
  const allowed = input.equipment.length ? new Set<Equipment>([...input.equipment, "Bodyweight"]) : null;
  const excluded = new Set(input.exclude);
  const pool = catalogue.filter(
    (e) =>
      equipmentOk(e, allowed) &&
      !excluded.has(e.id) &&
      !(input.reason === "equipment" && target.equipment !== "Bodyweight" && e.equipment === target.equipment),
  );
  return { target, reason: input.reason, allowed, candidates: swapOptions(pool, target, input.reason, MAX_CANDIDATES) };
}

// ---------------------------------------------------------------------------
// Rule reasons (no model)
// ---------------------------------------------------------------------------

const list = (xs: readonly string[]) => (xs.length ? xs.join(", ") : "the same muscles");

/** One plain sentence on why `alt` replaces `target` for `reason`. */
export function ruleReason(target: Exercise, alt: Exercise, reason: SwapReason): string {
  const shared = alt.muscle_groups.filter((m) => target.muscle_groups.includes(m));
  const muscles = list(shared);
  const sameEquip = alt.equipment === target.equipment;
  switch (reason) {
    case "busy":
      return sameEquip ? `Trains ${muscles} on a different setup.` : `Trains ${muscles} with ${alt.equipment} instead, so no waiting.`;
    case "equipment":
      return alt.equipment === "Bodyweight" ? `Trains ${muscles} with no equipment.` : `Trains ${muscles} with only ${alt.equipment}.`;
    case "hurts":
      return alt.equipment === "Machine/Cable"
        ? `Trains ${muscles} on a guided path that is easier to control.`
        : `Trains ${muscles} with a different movement.`;
    case "variety":
      return `A different way to train ${muscles}.`;
  }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = loadPrompt("swap-exercise", { maxAlternatives: MAX_ALTERNATIVES });

/** JSON schema for structured output. Ids and lengths are enforced again in parseResponse. */
export const SWAP_SCHEMA = {
  type: "object",
  properties: {
    alternatives: {
      type: "array",
      items: {
        type: "object",
        properties: {
          exercise_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["exercise_id", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["alternatives"],
  additionalProperties: false,
} as const;

const brief = (e: Exercise) => ({
  id: e.id,
  name: e.name,
  equipment: e.equipment,
  primary: e.muscle_groups,
  secondary: e.secondary_groups,
  mechanic: e.mechanic,
  force: e.force,
});

/** Data block the model sees. Only validated values, fixed text and catalogue fields go in. */
export function promptData(ctx: SwapContext) {
  return {
    exercise: brief(ctx.target),
    reason: ctx.reason,
    reason_detail: REASON_DETAIL[ctx.reason] ?? null,
    equipment: ctx.allowed ? [...ctx.allowed] : "any",
    max_alternatives: MAX_ALTERNATIVES,
    candidates: ctx.candidates.map(brief),
  };
}

export function buildPrompt(ctx: SwapContext): AiRequest {
  const data = escapeForTag(JSON.stringify(promptData(ctx)));
  return {
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `<user_data>\n${data}\n</user_data>\n\nRank the best replacements and give a reason for each.`,
      },
    ],
    output_config: { effort: "low", format: { type: "json_schema", schema: SWAP_SCHEMA as unknown as Record<string, unknown> } },
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export type AlternativeSource = "ai" | "rule";

export type Alternative = {
  exercise_id: string;
  reason: string;
  source: AlternativeSource;
};

export type SwapExerciseResult = {
  /** The exercise being swapped. */
  exercise_id: string;
  /** Best first: model picks in the model's order, then rule fills in rule order. */
  alternatives: Alternative[];
  /** Model picks dropped or changed, plus rule fills. */
  adjusted: number;
};

/** Reason text: plain, short, no emojis or control characters. */
export function cleanReason(v: unknown): string | null {
  const s = cleanNote(v);
  return s ? s.slice(0, MAX_REASON).trim() || null : null;
}

/**
 * Validates and clamps the model's JSON. Returns null when the shape is
 * unusable (not an object with an alternatives array). Otherwise every
 * alternative is one of ctx.candidates, at most once, at most
 * MAX_ALTERNATIVES in total; the list is topped up from the rule ranking.
 */
export function parseResponse(json: unknown, ctx: SwapContext): SwapExerciseResult | null {
  if (!isObj(json) || !Array.isArray(json.alternatives)) return null;
  const byId = new Map(ctx.candidates.map((e) => [e.id, e]));
  const picked: Alternative[] = [];
  let adjusted = 0;

  for (const item of json.alternatives as unknown[]) {
    const id = isObj(item) && typeof item.exercise_id === "string" ? item.exercise_id.trim() : null;
    const e = id === null ? undefined : byId.get(id);
    if (!isObj(item) || !e || picked.length >= MAX_ALTERNATIVES || picked.some((p) => p.exercise_id === e.id)) {
      adjusted++;
      continue;
    }
    const cleaned = cleanReason(item.reason);
    if (!cleaned) adjusted++;
    picked.push({ exercise_id: e.id, reason: cleaned ?? ruleReason(ctx.target, e, ctx.reason), source: "ai" });
  }

  const fills: Alternative[] = [];
  for (const e of ctx.candidates) {
    if (picked.length + fills.length >= MAX_ALTERNATIVES) break;
    if (picked.some((p) => p.exercise_id === e.id)) continue;
    fills.push({ exercise_id: e.id, reason: ruleReason(ctx.target, e, ctx.reason), source: "rule" });
  }
  adjusted += fills.length;

  return { exercise_id: ctx.target.id, alternatives: [...picked, ...fills], adjusted };
}

/** Alternatives built only from rules (no model). Same as clamping an empty model answer. */
export function ruleSwap(ctx: SwapContext): SwapExerciseResult {
  return parseResponse({ alternatives: [] }, ctx)!;
}

/** Parses the model's text, then clamps it. Null on invalid JSON or unusable shape. */
export function parseResponseText(text: string, ctx: SwapContext): SwapExerciseResult | null {
  const json = parseJsonText(text);
  return json === undefined ? null : parseResponse(json, ctx);
}
