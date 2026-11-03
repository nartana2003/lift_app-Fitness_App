/**
 * Server-only pure logic for the monthly weekly-target re-check
 * (GET /api/cron/target-recheck, lib/cron/targetsJob.ts).
 *
 * The user's current weekly set targets and the last 4 weeks of sets per
 * muscle go in; suggested raises or cuts come out. The user approves each one
 * in the app, so nothing here changes a target.
 *
 * - The rule-based check (ruleRecheck) needs no model: a target met every
 *   week goes up by RULE_STEP, a target never met and far off goes down by
 *   RULE_STEP, within MIN_TARGET..MAX_TARGET from lib/ai/goal-targets.ts.
 * - A model answer may only name muscles that have a target, and each new
 *   number is clamped to MAX_STEP from the current one. Anything else falls
 *   back to the rule result.
 *
 * No free text is accepted: muscles are MUSCLE_GROUPS names, numbers are
 * bounded ints, goal fields are enum values. All data reaches the prompt
 * JSON-encoded inside one <user_data> block that the system prompt declares
 * to be data only.
 */
import type { AiRequest } from "./client";
import { MUSCLE_GROUPS, type MuscleGroup } from "../muscles";
import { cleanNote } from "./generate-routines";
import { EXPERIENCES, GOAL_TYPES, MAX_TARGET, MAX_USER_TARGET, MAX_WEEK_SETS, MAX_WEEKS, MIN_TARGET, ruleTarget, type GoalSettings, type WeekSets } from "./goal-targets";
import { escapeForTag, isDateKey, isInt, isMuscle, isObj, onlyKeys, parseJsonText } from "./validate";
import type { Experience, GoalType } from "../goals";
import { loadPrompt } from "../../prompts/load";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Weeks of history needed before any change is suggested. */
export const MIN_WEEKS = 2;
/** Rule change per check. */
export const RULE_STEP = 2;
/** Largest change accepted from the model. */
export const MAX_STEP = 4;
/** A never-met target is cut only when the average is under this share of it. */
export const LOW_SHARE = 0.6;
export const MAX_REASON = 160;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type RecheckInput = {
  /** Null when the user has no saved goals. */
  goals: GoalSettings | null;
  /** Current weekly set target per muscle (only muscles with a target > 0). */
  targets: Partial<Record<MuscleGroup, number>>;
  /** MIN_WEEKS..MAX_WEEKS weeks, oldest first. */
  weeks: WeekSets[];
};

export type ValidateResult = { ok: true; input: RecheckInput } | { ok: false; error: string };

function muscleMap(v: unknown, lo: number, hi: number): Partial<Record<MuscleGroup, number>> | null {
  if (!isObj(v)) return null;
  const out: Partial<Record<MuscleGroup, number>> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!isMuscle(k) || !isInt(n, lo, hi)) return null;
    out[k] = n;
  }
  return out;
}

/** Strict check of the job's input. Unknown keys, unknown muscles and out-of-range numbers are rejected. */
export function validateInput(raw: unknown): ValidateResult {
  const bad = (error: string): ValidateResult => ({ ok: false, error });
  if (!isObj(raw) || !onlyKeys(raw, ["goals", "targets", "weeks"])) return bad("body");

  let goals: GoalSettings | null = null;
  const g = raw.goals;
  if (g !== undefined && g !== null) {
    if (!isObj(g) || !onlyKeys(g, ["goalType", "experience", "sessionsPerWeek", "focusMuscles"])) return bad("goals");
    if (!(GOAL_TYPES as readonly unknown[]).includes(g.goalType)) return bad("goals.goalType");
    if (!(EXPERIENCES as readonly unknown[]).includes(g.experience)) return bad("goals.experience");
    if (!isInt(g.sessionsPerWeek, 1, 7)) return bad("goals.sessionsPerWeek");
    if (!Array.isArray(g.focusMuscles) || g.focusMuscles.length > MUSCLE_GROUPS.length || !g.focusMuscles.every(isMuscle)) return bad("goals.focusMuscles");
    goals = {
      goalType: g.goalType as GoalType,
      experience: g.experience as Experience,
      sessionsPerWeek: g.sessionsPerWeek,
      focusMuscles: [...new Set(g.focusMuscles as MuscleGroup[])],
    };
  }

  const targets = muscleMap(raw.targets, 1, MAX_USER_TARGET);
  if (!targets || Object.keys(targets).length === 0) return bad("targets");

  if (!Array.isArray(raw.weeks) || raw.weeks.length < MIN_WEEKS || raw.weeks.length > MAX_WEEKS) return bad("weeks");
  const weeks: WeekSets[] = [];
  for (const w of raw.weeks) {
    if (!isObj(w) || !onlyKeys(w, ["week_start", "sets"]) || !isDateKey(w.week_start)) return bad("weeks");
    if (weeks.some((x) => x.week_start === w.week_start)) return bad("weeks.week_start");
    const sets = muscleMap(w.sets, 0, MAX_WEEK_SETS);
    if (!sets) return bad("weeks.sets");
    weeks.push({ week_start: w.week_start, sets });
  }
  weeks.sort((a, b) => a.week_start.localeCompare(b.week_start));
  return { ok: true, input: { goals, targets, weeks } };
}

// ---------------------------------------------------------------------------
// Result and the rule-based check
// ---------------------------------------------------------------------------

export type RecheckSource = "ai" | "rule";

export type TargetChange = {
  muscle: MuscleGroup;
  current: number;
  suggested: number;
  /** One short plain sentence. */
  reason: string;
};

export type RecheckResult = {
  changes: TargetChange[];
  source: RecheckSource;
  /** Model items dropped or changed (0 for a clean answer; 1 when the rule result replaced it). */
  adjusted: number;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Per-muscle facts the rule and the prompt share. */
function facts(input: RecheckInput) {
  return MUSCLE_GROUPS.filter((m) => input.targets[m] !== undefined).map((m) => {
    const target = input.targets[m]!;
    const done = input.weeks.map((w) => w.sets[m] ?? 0);
    return { muscle: m, target, done, met: done.filter((n) => n >= target).length, avg: round1(done.reduce((a, b) => a + b, 0) / done.length) };
  });
}

/** Changes from rules only: raise targets met every week, cut targets never met and far off. */
export function ruleChanges(input: RecheckInput): TargetChange[] {
  const out: TargetChange[] = [];
  const n = input.weeks.length;
  for (const f of facts(input)) {
    if (f.met === n && f.target < MAX_TARGET) {
      out.push({ muscle: f.muscle, current: f.target, suggested: Math.min(MAX_TARGET, f.target + RULE_STEP), reason: `You hit ${f.target} sets every week for ${n} weeks, so there is room to add a little.` });
    } else if (f.met === 0 && f.avg < f.target * LOW_SHARE && f.target > MIN_TARGET) {
      out.push({ muscle: f.muscle, current: f.target, suggested: Math.max(MIN_TARGET, f.target - RULE_STEP), reason: `You averaged ${f.avg} of ${f.target} sets, so a slightly lower target is easier to keep.` });
    }
  }
  return out;
}

export function ruleRecheck(input: RecheckInput): RecheckResult {
  return { changes: ruleChanges(input), source: "rule", adjusted: 0 };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = loadPrompt("target-recheck", { minTarget: MIN_TARGET, maxTarget: MAX_USER_TARGET, maxStep: MAX_STEP, maxReason: MAX_REASON });

export const RECHECK_SCHEMA = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: { muscle: { type: "string" }, sets: { type: "integer" }, reason: { type: "string" } },
        required: ["muscle", "sets", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["changes"],
  additionalProperties: false,
} as const;

/** Data block the model sees. Only validated values go in. */
export function promptData(input: RecheckInput) {
  return {
    goals: input.goals,
    week_starts: input.weeks.map((w) => w.week_start),
    muscles: facts(input).map((f) => ({
      muscle: f.muscle,
      target: f.target,
      sets_per_week: f.done,
      weeks_met: f.met,
      average: f.avg,
      ...(input.goals ? { rule_default: ruleTarget(f.muscle, input.goals) } : {}),
    })),
    rule_changes: ruleChanges(input).map((c) => ({ muscle: c.muscle, sets: c.suggested })),
  };
}

export function buildPrompt(input: RecheckInput): AiRequest {
  const data = escapeForTag(JSON.stringify(promptData(input)));
  return {
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `<user_data>\n${data}\n</user_data>\n\nSuggest changes to these weekly set targets.` }],
    output_config: { effort: "low", format: { type: "json_schema", schema: RECHECK_SCHEMA as unknown as Record<string, unknown> } },
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** Reason text: plain, short, no emojis or control characters. */
export function cleanReason(v: unknown): string | null {
  const s = cleanNote(v);
  return s ? s.slice(0, MAX_REASON).trim() || null : null;
}

/**
 * Validates and clamps the model's JSON. Null for an unusable shape. Each item
 * must name a muscle that has a target (once); its number is rounded and
 * clamped to MAX_STEP from the current target and MIN_TARGET..MAX_USER_TARGET.
 * Items that end up unchanged, and anything malformed, are dropped and counted.
 */
export function parseResponse(json: unknown, input: RecheckInput): RecheckResult | null {
  if (!isObj(json) || !Array.isArray(json.changes)) return null;
  let adjusted = 0;
  const changes: TargetChange[] = [];
  for (const item of json.changes as unknown[]) {
    const muscle = isObj(item) && isMuscle(item.muscle) ? item.muscle : null;
    const current = muscle ? input.targets[muscle] : undefined;
    if (!isObj(item) || !muscle || current === undefined || changes.some((c) => c.muscle === muscle)) {
      adjusted++;
      continue;
    }
    if (typeof item.sets !== "number" || !Number.isFinite(item.sets)) {
      adjusted++;
      continue;
    }
    const lo = Math.max(MIN_TARGET, current - MAX_STEP);
    const hi = Math.min(MAX_USER_TARGET, current + MAX_STEP);
    const suggested = Math.min(hi, Math.max(lo, Math.round(item.sets)));
    if (suggested !== item.sets) adjusted++;
    if (suggested === current) continue;
    let reason = cleanReason(item.reason);
    if (!reason) {
      adjusted++;
      reason = suggested > current ? "You have been meeting this target, so it can go up." : "This target has been hard to meet, so it can come down.";
    }
    changes.push({ muscle, current, suggested, reason });
  }
  return { changes, source: "ai", adjusted };
}

/** Parses the model's text, then clamps it. Null on invalid JSON or unusable shape. */
export function parseResponseText(text: string, input: RecheckInput): RecheckResult | null {
  const json = parseJsonText(text);
  return json === undefined ? null : parseResponse(json, input);
}
