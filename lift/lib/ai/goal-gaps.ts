/**
 * Server-only pure logic for POST /api/ai/goal-gaps.
 *
 * The muscles under their weekly target (with the sets still needed), the days
 * left this week and, optionally, the user's equipment go in; exercises to add
 * and which day to add each come out. Every model pick is clamped:
 * - the exercise id must be in the built-in catalogue and usable with the
 *   user's equipment (Bodyweight is always allowed),
 * - its primary muscles (Exercise.muscle_groups) must include the under-target
 *   muscle it is meant to fill,
 * - the day must be one of the days left this week,
 * - at most MAX_PER_DAY additions land on one day, the same exercise is never
 *   added twice to one day, and a muscle never gets more sets than it needs.
 * Whatever the model leaves unfilled is topped up from rule-based picks
 * (lib/suggest.ts suggestForMuscle) spread across the remaining days, so
 * rulePlan() works with no model at all.
 *
 * Targets reuse ruleTarget() from lib/ai/goal-targets.ts (no third copy of the
 * rule), and the optional goals object goes through that module's validator.
 *
 * No free text is accepted: muscles and equipment are enum values and days are
 * YYYY-MM-DD dates. All data reaches the prompt JSON-encoded inside one
 * <user_data> block that the system prompt declares to be data only.
 */
import type { AiRequest } from "./client";
import type { Exercise } from "../exercises";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "../muscles";
import { suggestForMuscle } from "../suggest";
import { cleanNote, cleanSets, equipmentOk } from "./generate-routines";
import { MAX_TARGET, MAX_USER_TARGET, ruleTarget, validateInput as validateTargetsInput, type GoalSettings } from "./goal-targets";
import { equipmentList, escapeForTag, isDateKey, isInt, isMuscle, isObj, onlyKeys, parseJsonText } from "./validate";
import { loadPrompt } from "../../prompts/load";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_BODY_BYTES = 8_192;
/** At most this many exercises are added to any one day. */
export const MAX_PER_DAY = 3;
/** Days in a week; days_left holds 1..7 dates. */
export const MAX_DAYS = 7;
/** Most sets one added exercise carries (same cap as generate-routines). */
export const MAX_SETS_PER_ADD = 6;
/** Rule-based picks split a muscle's sets into exercises of at most this many sets. */
export const RULE_SETS_PER_ADD = 3;
export const MAX_REASON = 200;
/** Catalogue exercises offered to the model per muscle. */
export const CANDIDATES_PER_MUSCLE = 6;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type GapInput = {
  muscle: MuscleGroup;
  /** Hard sets still needed this week to reach the target. */
  sets_remaining: number;
  /** The weekly target, when the client sends it. */
  target?: number;
};

export type GoalGapsInput = {
  gaps: GapInput[];
  /** YYYY-MM-DD, sorted, unique, inside one 7-day window. Usually today and the rest of the week. */
  days_left: string[];
  /** Equipment the user has. Empty means "no restriction". */
  equipment: Equipment[];
  /** Optional goal settings: used for focus muscles and to fill missing targets. */
  goals: (GoalSettings & { targets: Partial<Record<MuscleGroup, number>> }) | null;
};

export type ValidateResult = { ok: true; input: GoalGapsInput } | { ok: false; error: string };

/** Days since the epoch for a valid YYYY-MM-DD key. */
const dayIndex = (key: string) => Math.round(Date.parse(`${key}T00:00:00Z`) / 86_400_000);

/** Weekday name for a valid YYYY-MM-DD key. */
export const weekdayOf = (key: string) => WEEKDAYS[new Date(`${key}T00:00:00Z`).getUTCDay()];

/**
 * Strict shape check of the request body (already JSON-parsed). Unknown keys,
 * wrong types, unknown muscles or equipment, duplicate muscles or days, bad
 * dates and out-of-range numbers are rejected. goals goes through the
 * goal-targets validator.
 */
export function validateInput(raw: unknown): ValidateResult {
  const bad = (error: string): ValidateResult => ({ ok: false, error });
  if (!isObj(raw) || !onlyKeys(raw, ["gaps", "days_left", "equipment", "goals"])) return bad("body");

  let goals: GoalGapsInput["goals"] = null;
  if (raw.goals !== undefined && raw.goals !== null) {
    const r = validateTargetsInput({ goals: raw.goals });
    if (!r.ok) return bad(r.error);
    goals = r.input.goals;
  }

  if (!Array.isArray(raw.gaps) || raw.gaps.length < 1 || raw.gaps.length > MUSCLE_GROUPS.length) return bad("gaps");
  const gaps: GapInput[] = [];
  for (const g of raw.gaps) {
    if (!isObj(g) || !onlyKeys(g, ["muscle", "sets_remaining", "target"])) return bad("gaps");
    if (!isMuscle(g.muscle) || gaps.some((x) => x.muscle === g.muscle)) return bad("gaps.muscle");
    if (!isInt(g.sets_remaining, 1, MAX_TARGET)) return bad("gaps.sets_remaining");
    const gap: GapInput = { muscle: g.muscle, sets_remaining: g.sets_remaining };
    if (g.target !== undefined) {
      if (!isInt(g.target, 1, MAX_USER_TARGET)) return bad("gaps.target");
      if (g.sets_remaining > g.target) return bad("gaps.sets_remaining");
      gap.target = g.target;
    }
    gaps.push(gap);
  }

  if (!Array.isArray(raw.days_left) || raw.days_left.length < 1 || raw.days_left.length > MAX_DAYS) return bad("days_left");
  const days_left: string[] = [];
  for (const d of raw.days_left) {
    if (!isDateKey(d) || days_left.includes(d)) return bad("days_left");
    days_left.push(d);
  }
  days_left.sort();
  // All days must fall inside one 7-day window.
  if (dayIndex(days_left[days_left.length - 1]) - dayIndex(days_left[0]) >= MAX_DAYS) return bad("days_left");

  const equipment = equipmentList(raw.equipment ?? []);
  if (!equipment) return bad("equipment");

  return { ok: true, input: { gaps, days_left, equipment, goals } };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type Need = {
  muscle: MuscleGroup;
  sets_remaining: number;
  /** Weekly target: from the client, the user's own number, or ruleTarget(). Null when unknown. */
  target: number | null;
  focus: boolean;
};

export type GapContext = {
  /** Focus muscles first, then most sets remaining, then MUSCLE_GROUPS order. */
  needs: Need[];
  days: string[];
  /** Null means every equipment type is allowed. */
  allowed: Set<Equipment> | null;
  byId: Map<string, Exercise>;
  /** Per under-target muscle: usable catalogue exercises whose primary muscle it is, best first. */
  candidates: Map<MuscleGroup, Exercise[]>;
};

export function buildContext(input: GoalGapsInput, catalogue: Exercise[]): GapContext {
  const byId = new Map(catalogue.map((e) => [e.id, e]));
  const allowed = input.equipment.length ? new Set<Equipment>([...input.equipment, "Bodyweight"]) : null;
  const usable = catalogue.filter((e) => equipmentOk(e, allowed));
  const goals = input.goals;

  const needs = input.gaps
    .map(
      (g): Need => ({
        muscle: g.muscle,
        sets_remaining: g.sets_remaining,
        target: g.target ?? goals?.targets[g.muscle] ?? (goals ? ruleTarget(g.muscle, goals) : null),
        focus: !!goals?.focusMuscles.includes(g.muscle),
      }),
    )
    .sort(
      (a, b) =>
        Number(b.focus) - Number(a.focus) ||
        b.sets_remaining - a.sets_remaining ||
        MUSCLE_GROUPS.indexOf(a.muscle) - MUSCLE_GROUPS.indexOf(b.muscle),
    );

  const candidates = new Map<MuscleGroup, Exercise[]>();
  for (const n of needs) candidates.set(n.muscle, suggestForMuscle(usable, n.muscle, CANDIDATES_PER_MUSCLE));

  return { needs, days: [...input.days_left].sort(), allowed, byId, candidates };
}

// ---------------------------------------------------------------------------
// Spreading additions across the remaining days (pure, no model)
// ---------------------------------------------------------------------------

export type AdditionSource = "ai" | "rule";

export type Addition = {
  exercise_id: string;
  /** The under-target muscle this exercise fills (one of its primary muscles). */
  muscle: MuscleGroup;
  /** YYYY-MM-DD, one of the days left. */
  date: string;
  sets: number;
  reason: string;
  source: AdditionSource;
};

/** Splits n sets into near-equal pieces of at most `per` sets: 7 -> [3, 2, 2]. */
export function splitSets(n: number, per = RULE_SETS_PER_ADD): number[] {
  if (!Number.isFinite(n) || n < 1 || per < 1) return [];
  const total = Math.floor(n);
  const k = Math.ceil(total / per);
  const base = Math.floor(total / k);
  const extra = total % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

export function ruleReason(muscle: MuscleGroup, sets: number): string {
  return `Adds ${sets} ${muscle} set${sets === 1 ? "" : "s"} toward this week's target.`;
}

/**
 * Places rule-based picks for `needs` on `days`, on top of `existing`
 * additions. Each muscle's sets are split into pieces of at most
 * RULE_SETS_PER_ADD; each piece goes to the open day (under MAX_PER_DAY) that
 * does not yet train that muscle, then has the fewest additions, then comes
 * first. Exercises rotate through `picksFor(muscle)` (only those whose primary
 * muscle matches) and never repeat on one day. Pieces that cannot be placed are
 * left out. Returns only the new additions.
 */
export function spreadAdditions(
  needs: { muscle: MuscleGroup; sets: number }[],
  days: string[],
  picksFor: (muscle: MuscleGroup) => Exercise[],
  existing: Addition[] = [],
): Addition[] {
  const load = new Map<string, number>(days.map((d) => [d, 0]));
  const idsOn = new Map<string, Set<string>>(days.map((d) => [d, new Set<string>()]));
  const musclesOn = new Map<string, Set<MuscleGroup>>(days.map((d) => [d, new Set<MuscleGroup>()]));
  const place = (a: Addition) => {
    if (!load.has(a.date)) return;
    load.set(a.date, load.get(a.date)! + 1);
    idsOn.get(a.date)!.add(a.exercise_id);
    musclesOn.get(a.date)!.add(a.muscle);
  };
  for (const a of existing) place(a);

  const out: Addition[] = [];
  for (const need of needs) {
    const picks = picksFor(need.muscle).filter((e) => e.muscle_groups.includes(need.muscle));
    if (picks.length === 0) continue;
    let turn = 0;
    for (const sets of splitSets(need.sets)) {
      const open = days
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => load.get(d)! < MAX_PER_DAY)
        .sort(
          (a, b) =>
            Number(musclesOn.get(a.d)!.has(need.muscle)) - Number(musclesOn.get(b.d)!.has(need.muscle)) ||
            load.get(a.d)! - load.get(b.d)! ||
            a.i - b.i,
        );
      let placed: Addition | null = null;
      for (const { d } of open) {
        for (let k = 0; k < picks.length && !placed; k++) {
          const e = picks[(turn + k) % picks.length];
          if (!idsOn.get(d)!.has(e.id)) {
            placed = { exercise_id: e.id, muscle: need.muscle, date: d, sets, reason: ruleReason(need.muscle, sets), source: "rule" };
          }
        }
        if (placed) break;
      }
      if (!placed) break;
      place(placed);
      out.push(placed);
      turn++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = loadPrompt("goal-gaps", { maxPerDay: MAX_PER_DAY, maxSetsPerAdd: MAX_SETS_PER_ADD });

/** JSON schema for structured output. Ranges, ids and dates are enforced again in parseResponse. */
export const GAPS_SCHEMA = {
  type: "object",
  properties: {
    additions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          exercise_id: { type: "string" },
          muscle: { type: "string", enum: [...MUSCLE_GROUPS] },
          date: { type: "string" },
          sets: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["exercise_id", "muscle", "date", "sets", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["additions"],
  additionalProperties: false,
} as const;

/** Data block the model sees. Only validated values and catalogue fields go in. */
export function promptData(ctx: GapContext) {
  return {
    days: ctx.days.map((date) => ({ date, weekday: weekdayOf(date) })),
    max_per_day: MAX_PER_DAY,
    equipment: ctx.allowed ? [...ctx.allowed] : "any",
    gaps: ctx.needs.map((n) => ({
      muscle: n.muscle,
      sets_remaining: n.sets_remaining,
      target: n.target,
      focus: n.focus,
      candidates: (ctx.candidates.get(n.muscle) ?? []).map((e) => ({ id: e.id, name: e.name, equipment: e.equipment })),
    })),
  };
}

export function buildPrompt(ctx: GapContext): AiRequest {
  const data = escapeForTag(JSON.stringify(promptData(ctx)));
  return {
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `<user_data>\n${data}\n</user_data>\n\nChoose the exercises to add and the day for each.`,
      },
    ],
    output_config: { effort: "low", format: { type: "json_schema", schema: GAPS_SCHEMA as unknown as Record<string, unknown> } },
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export type GoalGapsResult = {
  /** Sorted by day, then in the order they were chosen. */
  additions: Addition[];
  /** Sets that could not be placed (no usable exercise, or every day full). */
  unmet: { muscle: MuscleGroup; sets: number }[];
  /** Model picks dropped or changed, plus rule-based fills. */
  adjusted: number;
};

/** Reason text: plain, short, no emojis or control characters. */
export function cleanReason(v: unknown): string | null {
  const s = cleanNote(v);
  return s ? s.slice(0, MAX_REASON).trim() || null : null;
}

/**
 * Validates and clamps the model's JSON. Returns null when the shape is
 * unusable (not an object with an additions array). Otherwise every addition
 * is a catalogue exercise usable with the user's equipment that trains its
 * under-target muscle as a primary muscle, on one of the days left, within the
 * per-day cap; whatever the model left unfilled is added by spreadAdditions().
 */
export function parseResponse(json: unknown, ctx: GapContext): GoalGapsResult | null {
  if (!isObj(json) || !Array.isArray(json.additions)) return null;
  const remaining = new Map<MuscleGroup, number>(ctx.needs.map((n) => [n.muscle, n.sets_remaining]));
  const perDay = new Map<string, number>(ctx.days.map((d) => [d, 0]));
  const picked: Addition[] = [];
  let adjusted = 0;

  for (const item of json.additions as unknown[]) {
    if (!isObj(item)) {
      adjusted++;
      continue;
    }
    const muscle = typeof item.muscle === "string" ? item.muscle.trim() : null;
    const date = typeof item.date === "string" ? item.date.trim() : null;
    const e = typeof item.exercise_id === "string" ? ctx.byId.get(item.exercise_id) : undefined;
    const left = isMuscle(muscle) ? remaining.get(muscle) : undefined;
    if (
      !isMuscle(muscle) ||
      left === undefined ||
      left <= 0 ||
      !e ||
      !e.muscle_groups.includes(muscle) ||
      !equipmentOk(e, ctx.allowed) ||
      date === null ||
      !perDay.has(date) ||
      perDay.get(date)! >= MAX_PER_DAY ||
      picked.some((p) => p.date === date && p.exercise_id === e.id)
    ) {
      adjusted++;
      continue;
    }
    const sets = Math.min(cleanSets(item.sets), MAX_SETS_PER_ADD, left);
    const cleaned = cleanReason(item.reason);
    if (sets !== item.sets || !cleaned) adjusted++;
    const reason = cleaned ?? ruleReason(muscle, sets);
    remaining.set(muscle, left - sets);
    perDay.set(date, perDay.get(date)! + 1);
    picked.push({ exercise_id: e.id, muscle, date, sets, reason, source: "ai" });
  }

  const still = ctx.needs.map((n) => ({ muscle: n.muscle, sets: remaining.get(n.muscle)! })).filter((n) => n.sets > 0);
  const fills = spreadAdditions(still, ctx.days, (m) => ctx.candidates.get(m) ?? [], picked);
  adjusted += fills.length;
  for (const f of fills) remaining.set(f.muscle, remaining.get(f.muscle)! - f.sets);

  const order = new Map(ctx.days.map((d, i) => [d, i]));
  const additions = [...picked, ...fills]
    .map((a, i) => ({ a, i }))
    .sort((x, y) => order.get(x.a.date)! - order.get(y.a.date)! || x.i - y.i)
    .map(({ a }) => a);
  const unmet = ctx.needs.map((n) => ({ muscle: n.muscle, sets: remaining.get(n.muscle)! })).filter((n) => n.sets > 0);
  return { additions, unmet, adjusted };
}

/** Additions built only from rules (no model). Same as clamping an empty model answer. */
export function rulePlan(ctx: GapContext): GoalGapsResult {
  return parseResponse({ additions: [] }, ctx)!;
}

/** Parses the model's text, then clamps it. Null on invalid JSON or unusable shape. */
export function parseResponseText(text: string, ctx: GapContext): GoalGapsResult | null {
  const json = parseJsonText(text);
  return json === undefined ? null : parseResponse(json, ctx);
}

/** The additions grouped per day left, in day order (days with none included). */
export function byDay(result: GoalGapsResult, days: string[]): { date: string; additions: Addition[] }[] {
  return days.map((date) => ({ date, additions: result.additions.filter((a) => a.date === date) }));
}
