/**
 * Server-only pure logic for POST /api/ai/overload-suggestion.
 *
 * The last 1-5 sessions of one exercise (plus, optionally, the user's goal and
 * the routine's rep range) go in; today's sets x reps x weight and a one-line
 * reason come out. The answer refines the rule-based default from
 * lib/overload.ts (suggest(), increment(), parseRepRange()), which is computed
 * here too, sent to the model as the starting point, and returned alongside the
 * refined answer so the client can always fall back to it.
 *
 * Every model number is clamped to a window around the last session:
 * - weight: snapped to the equipment's increment from the last top weight, at
 *   most 2 increments up and about 15% down (no change at all for equipment
 *   with no increment, such as bodyweight and bands), or exactly the rule weight;
 *   no increase at all after failure or missed reps, nothing above the rule
 *   weight after a hard (rir 1) session,
 * - reps: whole number within 2 of the rep range,
 * - sets: whole number within 1 of the rule's set count.
 * A missing or unusable field falls back to the rule value. The model's reason
 * is kept only when its numbers were accepted unchanged.
 *
 * No free text is accepted. The exercise id is a narrow-charset token; a
 * catalogue id supplies the name and equipment, any other id (custom
 * exercises) never reaches the prompt. Dates are YYYY-MM-DD, everything else is
 * a number, boolean or enum. All data reaches the prompt JSON-encoded inside
 * one <user_data> block that the system prompt declares to be data only.
 */
import type { AiRequest } from "./client";
import type { Exercise } from "../exercises";
import type { Equipment } from "../muscles";
import { increment, parseRepRange, suggest, type LoggedSet, type RepRange, type Suggestion } from "../overload";
import { cleanNote } from "./generate-routines";
import { validateInput as validateTargetsInput, type GoalSettings } from "./goal-targets";
import { escapeForTag, isDateKey, isEquipment, isInt, isNum, isObj, onlyKeys, parseJsonText } from "./validate";
import { loadPrompt } from "../../prompts/load";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_BODY_BYTES = 16_384;
export const MAX_SESSIONS = 5;
export const MAX_SETS_PER_SESSION = 20;
export const MAX_REPS = 100;
/** Heaviest weight (kg) accepted in or out. */
export const MAX_WEIGHT = 1000;
export const MAX_RIR = 5;
/** Rep ranges are 1..MAX_RANGE_REPS. */
export const MAX_RANGE_REPS = 50;
/** Most sets the answer may prescribe. */
export const MAX_SETS = 10;
export const MAX_REASON = 200;
export const MAX_ID = 80;
/** Weight may rise by at most this many equipment increments. */
export const MAX_UP_STEPS = 2;
/** Weight may drop to no less than this share of the last top weight. */
export const MIN_WEIGHT_SHARE = 0.85;
/** Reps may sit this far outside the rep range. */
export const REP_SLACK = 2;
/** Sets may differ from the rule's set count by this much. */
export const SET_SLACK = 1;

const ID_RE = /^[A-Za-z0-9_-]+$/;
const SET_KEYS = ["reps", "weight", "rir", "is_warmup"] as const;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type SessionInput = {
  /** YYYY-MM-DD. */
  date: string;
  sets: LoggedSet[];
};

export type OverloadInput = {
  exercise_id: string;
  /** Used when the id is not in the catalogue (custom exercises). */
  equipment: Equipment | null;
  /** The routine's rep target, when the client has one. */
  rep_range: RepRange | null;
  /** Sorted oldest first; the last one is the most recent session. */
  sessions: SessionInput[];
  goals: GoalSettings | null;
};

export type ValidateResult = { ok: true; input: OverloadInput } | { ok: false; error: string };

const hasWork = (sets: LoggedSet[]) => sets.some((s) => !s.is_warmup && s.reps > 0);

/**
 * Strict shape check of the request body (already JSON-parsed). Unknown keys,
 * wrong types, bad ids, dates, equipment and out-of-range numbers are rejected.
 * goals goes through the goal-targets validator. The most recent session must
 * hold at least one working set, so the rule-based default always exists.
 */
export function validateInput(raw: unknown): ValidateResult {
  const bad = (error: string): ValidateResult => ({ ok: false, error });
  if (!isObj(raw) || !onlyKeys(raw, ["exercise_id", "equipment", "rep_range", "sessions", "goals"])) return bad("body");

  const id = raw.exercise_id;
  if (typeof id !== "string" || id.length < 1 || id.length > MAX_ID || !ID_RE.test(id)) return bad("exercise_id");

  let equipment: Equipment | null = null;
  if (raw.equipment !== undefined && raw.equipment !== null) {
    if (!isEquipment(raw.equipment)) return bad("equipment");
    equipment = raw.equipment;
  }

  let rep_range: RepRange | null = null;
  if (raw.rep_range !== undefined && raw.rep_range !== null) {
    const r = raw.rep_range;
    if (!isObj(r) || !onlyKeys(r, ["min", "max"])) return bad("rep_range");
    if (!isInt(r.min, 1, MAX_RANGE_REPS) || !isInt(r.max, 1, MAX_RANGE_REPS) || r.min > r.max) return bad("rep_range");
    rep_range = { min: r.min, max: r.max };
  }

  if (!Array.isArray(raw.sessions) || raw.sessions.length < 1 || raw.sessions.length > MAX_SESSIONS) return bad("sessions");
  const sessions: SessionInput[] = [];
  for (const s of raw.sessions) {
    if (!isObj(s) || !onlyKeys(s, ["date", "sets"])) return bad("sessions");
    if (!isDateKey(s.date)) return bad("sessions.date");
    if (!Array.isArray(s.sets) || s.sets.length < 1 || s.sets.length > MAX_SETS_PER_SESSION) return bad("sessions.sets");
    const sets: LoggedSet[] = [];
    for (const x of s.sets) {
      if (!isObj(x) || !onlyKeys(x, SET_KEYS)) return bad("sessions.sets");
      if (!isInt(x.reps, 0, MAX_REPS) || !isNum(x.weight, 0, MAX_WEIGHT)) return bad("sessions.sets");
      if (x.rir !== undefined && x.rir !== null && !isInt(x.rir, 0, MAX_RIR)) return bad("sessions.sets.rir");
      if (x.is_warmup !== undefined && typeof x.is_warmup !== "boolean") return bad("sessions.sets.is_warmup");
      sets.push({ reps: x.reps, weight: x.weight, rir: (x.rir as number | null | undefined) ?? null, is_warmup: x.is_warmup === true });
    }
    sessions.push({ date: s.date, sets });
  }
  // Stable sort keeps the client's order for sessions on the same day.
  sessions.sort((a, b) => a.date.localeCompare(b.date));
  if (!hasWork(sessions[sessions.length - 1].sets)) return bad("sessions.sets");

  let goals: GoalSettings | null = null;
  if (raw.goals !== undefined && raw.goals !== null) {
    const r = validateTargetsInput({ goals: raw.goals });
    if (!r.ok) return bad(r.error);
    const { goalType, experience, sessionsPerWeek, focusMuscles } = r.input.goals;
    goals = { goalType, experience, sessionsPerWeek, focusMuscles };
  }

  return { ok: true, input: { exercise_id: id, equipment, rep_range, sessions, goals } };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type Bounds = {
  weightMin: number;
  weightMax: number;
  repsMin: number;
  repsMax: number;
  setsMin: number;
  setsMax: number;
};

export type OverloadContext = {
  exercise_id: string;
  /** Catalogue exercise for this id, or null (custom exercise). */
  exercise: Exercise | null;
  equipment: Equipment;
  /** kg per weight jump; 0 means "progress reps, not weight". */
  step: number;
  range: RepRange;
  sessions: SessionInput[];
  goals: GoalSettings | null;
  /** Heaviest working weight of the most recent session. */
  top: number;
  /** lib/overload.ts suggest() on the most recent session. */
  rule: Suggestion;
  bounds: Bounds;
};

/** Rounds away float noise (62.49999 -> 62.5). */
const r2 = (n: number) => Math.round(n * 100) / 100;

export type LastSessionFlags = {
  /** A top-weight working set was taken to failure (rir 0). */
  failure: boolean;
  /** The fewest reps at the top weight fell below the rep range (suggest()'s "missed" branch). */
  missed: boolean;
  /** A top-weight working set was rated hard (rir 1). */
  hard: boolean;
};

/** How the last session went at its top weight, judged the same way as lib/overload.ts suggest(). */
export function lastSessionFlags(last: LoggedSet[], range: RepRange): LastSessionFlags {
  const work = last.filter((s) => !s.is_warmup && s.reps > 0);
  if (work.length === 0) return { failure: false, missed: false, hard: false };
  const top = Math.max(...work.map((s) => s.weight));
  const atTop = work.filter((s) => s.weight === top);
  return {
    failure: atTop.some((s) => s.rir === 0),
    missed: Math.min(...atTop.map((s) => s.reps)) < range.min,
    hard: atTop.some((s) => s.rir === 1),
  };
}

/**
 * Allowed window for the answer, around the last session and the rule default.
 * When the last session's working sets are given, the upper limits also follow
 * the rule's verdict: after failure (rir 0) or missed reps no weight increase
 * and no extra set; after a hard session (rir 1) nothing above the rule weight.
 */
export function boundsFor(top: number, step: number, range: RepRange, rule: Suggestion, last: LoggedSet[] = []): Bounds {
  const down = step > 0 ? Math.floor((top * (1 - MIN_WEIGHT_SHARE)) / step + 1e-9) * step : 0;
  const flags = lastSessionFlags(last, range);
  let weightMax = Math.min(MAX_WEIGHT, top + MAX_UP_STEPS * step);
  let setsMax = Math.max(rule.sets, Math.min(MAX_SETS, rule.sets + SET_SLACK));
  // Hard session: never above the rule (which itself only goes up when the range top was hit).
  if (flags.hard) weightMax = Math.min(weightMax, Math.max(top, rule.weight));
  // Failure or missed reps: hold or drop only, and no extra set.
  if (flags.failure || flags.missed) {
    weightMax = Math.min(weightMax, top);
    setsMax = rule.sets;
  }
  return {
    weightMin: r2(Math.max(0, top - down)),
    weightMax: r2(weightMax),
    repsMin: Math.max(1, range.min - REP_SLACK),
    repsMax: range.max + REP_SLACK,
    setsMin: Math.max(1, rule.sets - SET_SLACK),
    setsMax,
  };
}

export function buildContext(input: OverloadInput, catalogue: Exercise[]): OverloadContext {
  const exercise = catalogue.find((e) => e.id === input.exercise_id) ?? null;
  const equipment: Equipment = exercise?.equipment ?? input.equipment ?? "Other";
  const step = increment(equipment);
  const range = input.rep_range ?? parseRepRange(undefined);
  const last = input.sessions[input.sessions.length - 1].sets;
  const work = last.filter((s) => !s.is_warmup && s.reps > 0);
  const top = Math.max(...work.map((s) => s.weight));
  // validateInput guarantees a working set, so suggest() is never null here.
  const rule = suggest(last, range, equipment)!;
  return {
    exercise_id: input.exercise_id,
    exercise,
    equipment,
    step,
    range,
    sessions: input.sessions,
    goals: input.goals,
    top,
    rule,
    bounds: boundsFor(top, step, range, rule, last),
  };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = loadPrompt("overload-suggestion");

/** JSON schema for structured output. Ranges are enforced again in parseResponse. */
export const OVERLOAD_SCHEMA = {
  type: "object",
  properties: {
    weight_kg: { type: "number" },
    reps: { type: "integer" },
    sets: { type: "integer" },
    reason: { type: "string" },
  },
  required: ["weight_kg", "reps", "sets", "reason"],
  additionalProperties: false,
} as const;

/** Data block the model sees. Only validated values and catalogue fields go in. */
export function promptData(ctx: OverloadContext) {
  const focus = ctx.goals && ctx.exercise ? ctx.exercise.muscle_groups.some((m) => ctx.goals!.focusMuscles.includes(m)) : null;
  return {
    exercise: {
      // Custom exercises are identified only by id; their user-typed names never reach the prompt.
      name: ctx.exercise?.name ?? null,
      equipment: ctx.equipment,
      increment_kg: ctx.step,
    },
    rep_range: ctx.range,
    goal: ctx.goals ? { goal_type: ctx.goals.goalType, experience: ctx.goals.experience, focus_muscle: focus } : null,
    sessions: ctx.sessions.map((s) => ({
      date: s.date,
      sets: s.sets.map((x) => ({ reps: x.reps, weight_kg: x.weight, rir: x.rir ?? null, warmup: x.is_warmup === true })),
    })),
    rule_default: { sets: ctx.rule.sets, reps: ctx.rule.reps, weight_kg: ctx.rule.weight, reason: ctx.rule.reason },
    limits: {
      weight_kg: { min: ctx.bounds.weightMin, max: ctx.bounds.weightMax },
      reps: { min: ctx.bounds.repsMin, max: ctx.bounds.repsMax },
      sets: { min: ctx.bounds.setsMin, max: ctx.bounds.setsMax },
    },
  };
}

export function buildPrompt(ctx: OverloadContext): AiRequest {
  const data = escapeForTag(JSON.stringify(promptData(ctx)));
  return {
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `<user_data>\n${data}\n</user_data>\n\nChoose today's sets, reps and weight for this exercise.`,
      },
    ],
    output_config: { effort: "low", format: { type: "json_schema", schema: OVERLOAD_SCHEMA as unknown as Record<string, unknown> } },
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export type SuggestionSource = "ai" | "rule";

export type OverloadSuggestion = Suggestion & { source: SuggestionSource };

export type OverloadResult = {
  exercise_id: string;
  /** Today's target: the model's answer after clamping, or the rule default. */
  suggestion: OverloadSuggestion;
  /** lib/overload.ts suggest() on the most recent session, unchanged. */
  rule: Suggestion;
  /** Model fields replaced or clamped. */
  adjusted: number;
};

/** Reason text: plain, short, no emojis or control characters. */
export function cleanReason(v: unknown): string | null {
  const s = cleanNote(v);
  return s ? s.slice(0, MAX_REASON).trim() || null : null;
}

/** Reason used when the model's own reason cannot be kept. */
export function fallbackReason(s: { sets: number; reps: number; weight: number }, rule: Suggestion): string {
  if (s.sets === rule.sets && s.reps === rule.reps && s.weight === rule.weight) return rule.reason;
  return "Adjusted from your last few sessions.";
}

const clampInt = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** The model's weight, snapped to the increment grid from the last top weight and kept inside the bounds. */
export function clampWeight(v: unknown, ctx: OverloadContext): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v === ctx.rule.weight) return v;
  const { weightMin, weightMax } = ctx.bounds;
  if (ctx.step <= 0) return ctx.top;
  const snapped = r2(ctx.top + Math.round((v - ctx.top) / ctx.step) * ctx.step);
  return Math.min(weightMax, Math.max(weightMin, snapped));
}

/**
 * Validates and clamps the model's JSON. Returns null when it is not an object.
 * Otherwise every number lies inside ctx.bounds (or equals the rule default),
 * missing or unusable fields fall back to the rule default, and the reason is
 * the model's only when nothing was changed.
 */
export function parseResponse(json: unknown, ctx: OverloadContext): OverloadResult | null {
  if (!isObj(json)) return null;
  const { rule, bounds } = ctx;
  let adjusted = 0;
  let fromModel = 0;

  const w = clampWeight(json.weight_kg, ctx);
  const weight = w ?? rule.weight;
  if (w === null || w !== json.weight_kg) adjusted++;
  if (w !== null) fromModel++;

  const repsOk = typeof json.reps === "number" && Number.isFinite(json.reps);
  const reps = repsOk ? clampInt(json.reps as number, bounds.repsMin, bounds.repsMax) : rule.reps;
  if (!repsOk || reps !== json.reps) adjusted++;
  if (repsOk) fromModel++;

  const setsOk = typeof json.sets === "number" && Number.isFinite(json.sets);
  const sets = setsOk ? clampInt(json.sets as number, bounds.setsMin, bounds.setsMax) : rule.sets;
  if (!setsOk || sets !== json.sets) adjusted++;
  if (setsOk) fromModel++;

  const cleaned = cleanReason(json.reason);
  if (!cleaned) adjusted++;
  const numbers = { sets, reps, weight };
  const reason = cleaned && adjusted === 0 ? cleaned : fallbackReason(numbers, rule);

  return {
    exercise_id: ctx.exercise_id,
    suggestion: { ...numbers, reason, source: fromModel > 0 ? "ai" : "rule" },
    rule,
    adjusted,
  };
}

/** The rule-based answer in the route's shape (no model). */
export function ruleResult(ctx: OverloadContext): OverloadResult {
  return { exercise_id: ctx.exercise_id, suggestion: { ...ctx.rule, source: "rule" }, rule: ctx.rule, adjusted: 0 };
}

/** Parses the model's text, then clamps it. Null on invalid JSON or unusable shape. */
export function parseResponseText(text: string, ctx: OverloadContext): OverloadResult | null {
  const json = parseJsonText(text);
  return json === undefined ? null : parseResponse(json, ctx);
}

