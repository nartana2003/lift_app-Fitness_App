/**
 * Server-only pure logic for POST /api/ai/summary (PLAN.md:202,
 * weekly-summary / monthly-summary as one route with a period field).
 *
 * A stats JSON for one week or one month goes in: session count, total
 * duration, total volume, sets per muscle group, personal records, skipped and
 * moved counts with reasons, the previous period's stats for comparison and an
 * optional short list of exercise highlights ("3x10 at 60kg twice"). A short
 * coach-style recap with progressive-overload advice comes out.
 *
 * Safety:
 * - No free text is accepted. Every field is a number, a fixed-enum string
 *   (period, unit, muscle group, skip reason, PR type) or an exercise id that
 *   must exist in the built-in catalogue. Lists are capped.
 * - All data reaches the prompt JSON-encoded and escaped inside one
 *   <user_data> block that the fixed system prompt declares to be data only.
 * - The model's answer is clamped: at most MAX_RECAP_LINES recap sentences and
 *   MAX_ADVICE advice items, all cleaned with cleanNote (no emojis, no control
 *   characters) and length-capped; an advice item that names an exercise must
 *   name one of the exercises in the request, else it is dropped.
 *
 * ruleSummary() builds the same result shape from the stats with no model, so
 * the feature works without AI.
 */
import type { AiRequest } from "./client";
import type { Exercise } from "../exercises";
import { MUSCLE_GROUPS, type MuscleGroup } from "../muscles";
import type { SkipReason } from "../offline/db";
import { increment } from "../overload";
import { PR_LABEL, type PrType } from "../prs";
import { formatDuration } from "../stats";
import { dispNum, fmtVolume, type Unit } from "../units";
import { cleanNote } from "./generate-routines";
import { escapeForTag, isInt, isMuscle, isNum, isObj, onlyKeys, parseJsonText } from "./validate";
import { loadPrompt } from "../../prompts/load";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_BODY_BYTES = 8_192;
export const PERIODS = ["week", "month"] as const;
export type Period = (typeof PERIODS)[number];
export const UNITS = ["kg", "lb"] as const satisfies readonly Unit[];
/**
 * Same values as SkipReason in lib/offline/db.ts (lib/planner.ts is client-only, so not imported).
 * The drift check covers both directions: `satisfies` fails if this list has a value SkipReason lacks,
 * and SKIP_REASONS_COMPLETE below fails if SkipReason gains a member this list lacks.
 */
export const SKIP_REASON_KEYS = ["busy", "tired", "sore", "sick", "injury", "travel", "rest", "other"] as const satisfies readonly SkipReason[];
const SKIP_REASONS_COMPLETE: [Exclude<SkipReason, (typeof SKIP_REASON_KEYS)[number]>] extends [never] ? true : never = true;
void SKIP_REASONS_COMPLETE;
export const PR_TYPES = Object.keys(PR_LABEL) as PrType[];

/** Most sessions in one period (a month with two a day). */
export const MAX_SESSIONS = 62;
/** Most seconds in one period (31 days). */
export const MAX_DURATION_SEC = 31 * 86_400;
/** Most total volume in kg for one period. */
export const MAX_VOLUME = 5_000_000;
/** Most hard sets for one muscle in one period. */
export const MAX_MUSCLE_SETS = 500;
/** Most skipped or moved days in one period. */
export const MAX_DAYS_OFF = 31;
export const MAX_PRS = 10;
export const MAX_PR_VALUE = 100_000;
export const MAX_HIGHLIGHTS = 8;
export const MAX_HL_SETS = 20;
export const MAX_HL_REPS = 100;
export const MAX_HL_WEIGHT = 1_000;
export const MAX_HL_TIMES = 31;
/** Catalogue ids are short; longer strings are rejected before any lookup. */
export const MAX_ID_LEN = 120;

/** Recap sentences kept from the model. */
export const MAX_RECAP_LINES = 4;
/** Longest recap sentence (cleanNote itself caps at 240). */
export const MAX_RECAP_LINE = 240;
export const MAX_ADVICE = 3;
export const MAX_ADVICE_TEXT = 200;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type PrInput = { exercise_id: string; type: PrType; value: number };

export type Highlight = {
  exercise_id: string;
  sets: number;
  reps: number;
  /** kg; 0 for bodyweight. */
  weight: number;
  /** Sessions in the period where this exact sets x reps x weight was done. */
  times: number;
};

export type BaseStats = {
  sessions: number;
  duration_sec: number;
  /** kg */
  volume: number;
  sets_by_muscle: Partial<Record<MuscleGroup, number>>;
  skipped: number;
  moved: number;
};

export type CurrentStats = BaseStats & {
  skip_reasons: Partial<Record<SkipReason, number>>;
  prs: PrInput[];
};

export type SummaryInput = {
  period: Period;
  unit: Unit;
  current: CurrentStats;
  previous: BaseStats | null;
  highlights: Highlight[];
};

export type ValidateResult = { ok: true; input: SummaryInput } | { ok: false; error: string };

const isPeriod = (v: unknown): v is Period => typeof v === "string" && (PERIODS as readonly string[]).includes(v);
const isUnit = (v: unknown): v is Unit => typeof v === "string" && (UNITS as readonly string[]).includes(v);
const isSkipReason = (v: unknown): v is SkipReason => typeof v === "string" && (SKIP_REASON_KEYS as readonly string[]).includes(v);
const isPrType = (v: unknown): v is PrType => typeof v === "string" && (PR_TYPES as readonly string[]).includes(v);

const BASE_KEYS = ["sessions", "duration_sec", "volume", "sets_by_muscle", "skipped", "moved"] as const;

/** A catalogue exercise id (exact). */
function catalogueId(v: unknown, byId: ReadonlyMap<string, Exercise>): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LEN && byId.has(v);
}

function validateBase(raw: unknown, extra: readonly string[]): BaseStats | string {
  if (!isObj(raw) || !onlyKeys(raw, [...BASE_KEYS, ...extra])) return "stats";
  if (!isInt(raw.sessions, 0, MAX_SESSIONS)) return "sessions";
  if (!isInt(raw.duration_sec, 0, MAX_DURATION_SEC)) return "duration_sec";
  if (!isNum(raw.volume, 0, MAX_VOLUME)) return "volume";
  if (!isInt(raw.skipped, 0, MAX_DAYS_OFF)) return "skipped";
  if (!isInt(raw.moved, 0, MAX_DAYS_OFF)) return "moved";
  if (!isObj(raw.sets_by_muscle)) return "sets_by_muscle";
  const sets_by_muscle: Partial<Record<MuscleGroup, number>> = {};
  for (const [k, n] of Object.entries(raw.sets_by_muscle)) {
    if (!isMuscle(k) || !isInt(n, 0, MAX_MUSCLE_SETS)) return "sets_by_muscle";
    sets_by_muscle[k] = n;
  }
  return {
    sessions: raw.sessions,
    duration_sec: raw.duration_sec,
    volume: raw.volume,
    sets_by_muscle,
    skipped: raw.skipped,
    moved: raw.moved,
  };
}

/**
 * Strict shape check of the request body (already JSON-parsed). Unknown keys,
 * wrong types, out-of-range numbers, unknown enum values, exercise ids that
 * are not in `byId`, duplicates and over-long lists are all rejected.
 */
export function validateInput(raw: unknown, byId: ReadonlyMap<string, Exercise>): ValidateResult {
  const bad = (error: string): ValidateResult => ({ ok: false, error });
  if (!isObj(raw) || !onlyKeys(raw, ["period", "unit", "current", "previous", "highlights"])) return bad("body");
  if (!isPeriod(raw.period)) return bad("period");
  if (raw.unit !== undefined && !isUnit(raw.unit)) return bad("unit");
  const unit: Unit = raw.unit ?? "kg";

  // current
  const base = validateBase(raw.current, ["skip_reasons", "prs"]);
  if (typeof base === "string") return bad(`current.${base}`);
  const cur = raw.current as Record<string, unknown>;

  const skip_reasons: Partial<Record<SkipReason, number>> = {};
  if (cur.skip_reasons !== undefined) {
    if (!isObj(cur.skip_reasons)) return bad("current.skip_reasons");
    let total = 0;
    for (const [k, n] of Object.entries(cur.skip_reasons)) {
      if (!isSkipReason(k) || !isInt(n, 0, MAX_DAYS_OFF)) return bad("current.skip_reasons");
      skip_reasons[k] = n;
      total += n;
    }
    if (total > base.skipped + base.moved) return bad("current.skip_reasons");
  }

  const prs: PrInput[] = [];
  if (cur.prs !== undefined) {
    if (!Array.isArray(cur.prs) || cur.prs.length > MAX_PRS) return bad("current.prs");
    for (const p of cur.prs) {
      if (!isObj(p) || !onlyKeys(p, ["exercise_id", "type", "value"])) return bad("current.prs");
      if (!catalogueId(p.exercise_id, byId)) return bad("current.prs.exercise_id");
      if (!isPrType(p.type)) return bad("current.prs.type");
      if (!isNum(p.value, 0, MAX_PR_VALUE)) return bad("current.prs.value");
      if (prs.some((x) => x.exercise_id === p.exercise_id && x.type === p.type)) return bad("current.prs");
      prs.push({ exercise_id: p.exercise_id, type: p.type, value: p.value });
    }
  }

  // previous
  let previous: BaseStats | null = null;
  if (raw.previous !== undefined && raw.previous !== null) {
    const prev = validateBase(raw.previous, []);
    if (typeof prev === "string") return bad(`previous.${prev}`);
    previous = prev;
  }

  // highlights
  const highlights: Highlight[] = [];
  if (raw.highlights !== undefined) {
    if (!Array.isArray(raw.highlights) || raw.highlights.length > MAX_HIGHLIGHTS) return bad("highlights");
    for (const h of raw.highlights) {
      if (!isObj(h) || !onlyKeys(h, ["exercise_id", "sets", "reps", "weight", "times"])) return bad("highlights");
      if (!catalogueId(h.exercise_id, byId)) return bad("highlights.exercise_id");
      if (!isInt(h.sets, 1, MAX_HL_SETS)) return bad("highlights.sets");
      if (!isInt(h.reps, 1, MAX_HL_REPS)) return bad("highlights.reps");
      if (!isNum(h.weight, 0, MAX_HL_WEIGHT)) return bad("highlights.weight");
      if (!isInt(h.times, 1, MAX_HL_TIMES)) return bad("highlights.times");
      if (highlights.some((x) => x.exercise_id === h.exercise_id)) return bad("highlights");
      highlights.push({ exercise_id: h.exercise_id, sets: h.sets, reps: h.reps, weight: h.weight, times: h.times });
    }
  }

  return {
    ok: true,
    input: { period: raw.period, unit, current: { ...base, skip_reasons, prs }, previous, highlights },
  };
}

// ---------------------------------------------------------------------------
// Context and rule-based next steps (pure, no model)
// ---------------------------------------------------------------------------

export type NextStep = {
  exercise_id: string;
  /** The suggested next target, in the display unit. */
  sets: number;
  reps: number;
  /** Display-unit weight; equal to the current weight when progressing reps. */
  weight: number;
  kind: "weight" | "reps" | "hold";
};

export type SummaryContext = {
  input: SummaryInput;
  /** Only the exercises named in the request (highlights and PRs). */
  exercises: Map<string, Exercise>;
  next: NextStep[];
};

/** Weight step in the display unit: lib/overload.ts increment() for kg, 5lb for loaded lifts in lb. */
export function stepFor(e: Exercise | undefined, unit: Unit): number {
  const kg = e ? increment(e.equipment) : 0;
  if (kg <= 0) return 0;
  return unit === "lb" ? 5 : kg;
}

/**
 * The next target for a highlight. Repeated at least twice: add one weight
 * step (or one rep when the lift has no weight step). Done once: hold and
 * repeat it before adding load.
 */
export function nextStep(h: Highlight, e: Exercise | undefined, unit: Unit): NextStep {
  const w = dispNum(h.weight, unit);
  if (h.times < 2) return { exercise_id: h.exercise_id, sets: h.sets, reps: h.reps, weight: w, kind: "hold" };
  const step = stepFor(e, unit);
  if (step > 0 && h.weight > 0) {
    return { exercise_id: h.exercise_id, sets: h.sets, reps: h.reps, weight: Math.round((w + step) * 10) / 10, kind: "weight" };
  }
  return { exercise_id: h.exercise_id, sets: h.sets, reps: Math.min(h.reps + 1, MAX_HL_REPS), weight: w, kind: "reps" };
}

export function buildContext(input: SummaryInput, catalogue: Exercise[]): SummaryContext {
  const all = new Map(catalogue.map((e) => [e.id, e]));
  const exercises = new Map<string, Exercise>();
  for (const id of [...input.highlights.map((h) => h.exercise_id), ...input.current.prs.map((p) => p.exercise_id)]) {
    const e = all.get(id);
    if (e) exercises.set(id, e);
  }
  const next = input.highlights.map((h) => nextStep(h, exercises.get(h.exercise_id), input.unit));
  return { input, exercises, next };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type SummarySource = "ai" | "rule";

export type SummaryAdvice = {
  /** A catalogue id from the request, or null for general advice. */
  exercise_id: string | null;
  text: string;
  source: SummarySource;
};

export type SummaryResult = {
  period: Period;
  /** 1..MAX_RECAP_LINES short plain sentences. */
  recap: string[];
  recap_source: SummarySource;
  /** 0..MAX_ADVICE items. */
  advice: SummaryAdvice[];
  /** Model items dropped or changed, plus rule-based fills. */
  adjusted: number;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nameOf = (ctx: SummaryContext, id: string) => ctx.exercises.get(id)?.name ?? id;
const fmtNum = (n: number) => `${Math.round(n * 10) / 10}`;

/** "3x10 at 60kg" in the display unit; bodyweight lifts drop the weight. */
function setsText(sets: number, reps: number, weight: number, unit: Unit): string {
  return weight > 0 ? `${sets}x${reps} at ${fmtNum(weight)}${unit}` : `${sets}x${reps}`;
}

function timesText(n: number): string {
  if (n === 1) return "once";
  if (n === 2) return "twice";
  return `${n} times`;
}

/** Rule-based advice text for one highlight. */
export function ruleAdviceText(ctx: SummaryContext, h: Highlight, step: NextStep): string {
  const unit = ctx.input.unit;
  const name = nameOf(ctx, h.exercise_id);
  const did = `${name}: ${setsText(h.sets, h.reps, dispNum(h.weight, unit), unit)} ${timesText(h.times)}`;
  if (step.kind === "weight") return `${did}. Try ${fmtNum(step.weight)}${unit} next time.`;
  if (step.kind === "reps") return `${did}. Try ${step.reps} reps per set next time.`;
  return `${did}. Repeat it once more before adding weight.`;
}

function ruleAdvice(ctx: SummaryContext): SummaryAdvice[] {
  const order = ctx.next
    .map((s, i) => ({ s, h: ctx.input.highlights[i], i }))
    .sort((a, b) => Number(b.s.kind !== "hold") - Number(a.s.kind !== "hold") || a.i - b.i);
  return order.slice(0, MAX_ADVICE).map(({ s, h }) => ({ exercise_id: h.exercise_id, text: ruleAdviceText(ctx, h, s), source: "rule" }));
}

function changeText(cur: number, prev: number, unitWord: string): string | null {
  if (prev === 0) return null;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return `the same ${unitWord}`;
  return `${Math.abs(pct)}% ${pct > 0 ? "more" : "less"} ${unitWord}`;
}

/** Plain recap sentences from the stats, no model. */
export function ruleRecap(ctx: SummaryContext): string[] {
  const { period, unit, current: c, previous: p } = ctx.input;
  const label = period === "week" ? "this week" : "this month";
  const last = period === "week" ? "last week" : "last month";
  const lines: string[] = [];

  if (c.sessions === 0) {
    lines.push(`No workouts logged ${label}.`);
  } else {
    lines.push(
      `${label[0].toUpperCase()}${label.slice(1)}: ${plural(c.sessions, "session")}, ${formatDuration(c.duration_sec)} of training and ${fmtVolume(c.volume, unit)} total volume.`,
    );
  }

  if (p) {
    const diff = c.sessions - p.sessions;
    const sess = diff === 0 ? "the same number of sessions" : `${plural(Math.abs(diff), "session")} ${diff > 0 ? "more" : "fewer"}`;
    const vol = changeText(c.volume, p.volume, "volume");
    lines.push(`Compared with ${last}: ${sess}${vol ? ` and ${vol}` : ""}.`);
  }

  const muscles = MUSCLE_GROUPS.map((m) => ({ m, n: c.sets_by_muscle[m] ?? 0 })).filter((x) => x.n > 0);
  if (muscles.length) {
    const top = [...muscles].sort((a, b) => b.n - a.n || MUSCLE_GROUPS.indexOf(a.m) - MUSCLE_GROUPS.indexOf(b.m))[0];
    lines.push(`Most sets went to ${top.m} (${top.n}), across ${plural(muscles.length, "muscle group")}.`);
  }

  const extras: string[] = [];
  if (c.prs.length) extras.push(`${plural(c.prs.length, "personal record")}, including ${nameOf(ctx, c.prs[0].exercise_id)}`);
  const off = c.skipped + c.moved;
  if (off > 0) {
    const reasons = SKIP_REASON_KEYS.map((k) => ({ k, n: c.skip_reasons[k] ?? 0 })).filter((x) => x.n > 0);
    const top = reasons.sort((a, b) => b.n - a.n)[0];
    const parts = [c.skipped ? `${c.skipped} skipped` : null, c.moved ? `${c.moved} moved` : null].filter(Boolean).join(", ");
    extras.push(`${plural(off, "planned day")} changed (${parts})${top ? `, mostly ${top.k}` : ""}`);
  }
  if (extras.length) lines.push(`${extras.join(". ")}.`.replace(/^./, (s) => s.toUpperCase()));

  return lines.slice(0, MAX_RECAP_LINES);
}

/** The whole summary from rules only (no model). */
export function ruleSummary(ctx: SummaryContext): SummaryResult {
  return { period: ctx.input.period, recap: ruleRecap(ctx), recap_source: "rule", advice: ruleAdvice(ctx), adjusted: 0 };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = loadPrompt("summary", { maxRecapLines: MAX_RECAP_LINES, maxAdvice: MAX_ADVICE, maxAdviceText: MAX_ADVICE_TEXT });

/** JSON schema for structured output. Counts, lengths and ids are enforced again in parseResponse. */
export const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    recap: { type: "array", items: { type: "string" } },
    advice: {
      type: "array",
      items: {
        type: "object",
        properties: {
          exercise_id: { anyOf: [{ type: "string" }, { type: "null" }] },
          text: { type: "string" },
        },
        required: ["exercise_id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["recap", "advice"],
  additionalProperties: false,
} as const;

/** Data block the model sees. Only validated values and catalogue fields go in. */
export function promptData(ctx: SummaryContext) {
  const { period, unit, current: c, previous: p } = ctx.input;
  const ex = (id: string) => ({ id, name: nameOf(ctx, id), equipment: ctx.exercises.get(id)?.equipment ?? null });
  const base = (s: BaseStats) => ({
    sessions: s.sessions,
    duration_min: Math.round(s.duration_sec / 60),
    volume: dispNum(s.volume, unit),
    sets_by_muscle: Object.fromEntries(MUSCLE_GROUPS.filter((m) => s.sets_by_muscle[m] !== undefined).map((m) => [m, s.sets_by_muscle[m]])),
    skipped: s.skipped,
    moved: s.moved,
  });
  return {
    period,
    unit,
    current: {
      ...base(c),
      skip_reasons: Object.fromEntries(SKIP_REASON_KEYS.filter((k) => c.skip_reasons[k]).map((k) => [k, c.skip_reasons[k]])),
      personal_records: c.prs.map((r) => ({
        exercise: ex(r.exercise_id),
        type: r.type,
        value: r.type === "reps" ? r.value : dispNum(r.value, unit),
      })),
    },
    previous: p ? base(p) : null,
    highlights: ctx.input.highlights.map((h, i) => ({
      exercise: ex(h.exercise_id),
      sets: h.sets,
      reps: h.reps,
      weight: dispNum(h.weight, unit),
      times: h.times,
      next_step: { sets: ctx.next[i].sets, reps: ctx.next[i].reps, weight: ctx.next[i].weight, kind: ctx.next[i].kind },
    })),
  };
}

export function buildPrompt(ctx: SummaryContext): AiRequest {
  const data = escapeForTag(JSON.stringify(promptData(ctx)));
  const which = ctx.input.period === "week" ? "weekly" : "monthly";
  return {
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `<user_data>\n${data}\n</user_data>\n\nWrite the ${which} recap and the overload advice.`,
      },
    ],
    output_config: { effort: "low", format: { type: "json_schema", schema: SUMMARY_SCHEMA as unknown as Record<string, unknown> } },
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
 * an object with recap and advice arrays). Otherwise recap lines and advice
 * texts are cleaned and capped, advice naming an exercise not in the request
 * is dropped, duplicates are dropped, and an empty recap or advice list is
 * filled from the rule-based summary.
 */
export function parseResponse(json: unknown, ctx: SummaryContext): SummaryResult | null {
  if (!isObj(json) || !Array.isArray(json.recap) || !Array.isArray(json.advice)) return null;
  let adjusted = 0;

  const recap: string[] = [];
  for (const line of json.recap as unknown[]) {
    const s = cleanText(line, MAX_RECAP_LINE);
    if (!s || recap.length >= MAX_RECAP_LINES || recap.includes(s)) {
      adjusted++;
      continue;
    }
    if (s !== line) adjusted++;
    recap.push(s);
  }

  const advice: SummaryAdvice[] = [];
  for (const item of json.advice as unknown[]) {
    if (!isObj(item) || advice.length >= MAX_ADVICE) {
      adjusted++;
      continue;
    }
    const id = item.exercise_id ?? null;
    if (id !== null && (typeof id !== "string" || !ctx.exercises.has(id) || advice.some((a) => a.exercise_id === id))) {
      adjusted++;
      continue;
    }
    const text = cleanText(item.text, MAX_ADVICE_TEXT);
    if (!text || advice.some((a) => a.text === text)) {
      adjusted++;
      continue;
    }
    if (text !== item.text) adjusted++;
    advice.push({ exercise_id: id, text, source: "ai" });
  }

  let recap_source: SummarySource = "ai";
  let lines = recap;
  if (lines.length === 0) {
    lines = ruleRecap(ctx);
    recap_source = "rule";
    adjusted++;
  }
  if (advice.length === 0) {
    const fills = ruleAdvice(ctx);
    adjusted += fills.length;
    advice.push(...fills);
  }

  return { period: ctx.input.period, recap: lines, recap_source, advice, adjusted };
}

/** Parses the model's text, then clamps it. Null on invalid JSON or unusable shape. */
export function parseResponseText(text: string, ctx: SummaryContext): SummaryResult | null {
  const json = parseJsonText(text);
  return json === undefined ? null : parseResponse(json, ctx);
}
