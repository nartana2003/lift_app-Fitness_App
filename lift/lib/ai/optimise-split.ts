/**
 * Server-only pure logic for POST /api/ai/optimise-split (Lift Coach, CO-04).
 *
 * The user's goals, split, routines and equipment go in; the Optimise proposals
 * come out. The rules decide WHAT to change: analyseSplit() and proposeChanges()
 * from lib/coachOptimise.ts run first, on this server, and are the answer
 * whenever the model is not used or its answer is unusable (ruleResponse).
 *
 * The model can only do two things: put the proposed changes in a better order
 * and re-word each change's "why". It cannot add, remove or change a change, add
 * evidence, or add text of its own:
 * - ids in its answer are clamped to the ids the rules proposed; repeats and
 *   unknown ids are dropped;
 * - a change it leaves out is kept, after the ones it ordered (it cannot hide a
 *   safety swap);
 * - a "why" it wrote is used only if it is a clean plain line, else the rule text;
 * - exercise ids, sets, reps, day ids and evidence ids always come from the rules.
 *
 * No free text is accepted. Day names are the only user text in the body; they
 * are normalised and tag-checked (textField), used in the rule text, and never
 * sent as separate fields. Everything reaches the prompt JSON-encoded and escaped
 * inside one <user_data> block that the system prompt declares to be data only.
 * Custom exercises are not accepted (ids must be in the catalogue).
 */
import type { AiRequest } from "./client";
import type { Exercise } from "../exercises";
import type { Experience, GoalType, Priority } from "../goals";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "../muscles";
import { isLimitation, type Limitation } from "../limitations";
import {
  analyseSplit,
  MAX_CHANGES,
  proposeChanges,
  type Analysis,
  type Change,
  type OptimiseInput,
  type PlanRoutine,
  type Proposals,
} from "../coachOptimise";
import { evidenceById } from "../evidence/library";
import { cleanNote, MAX_NOTE } from "./generate-routines";
import { EXPERIENCES, GOAL_TYPES, MAX_USER_TARGET } from "./goal-targets";
import { isTagLike, normaliseText, textField } from "./parse-log";
import { equipmentList, escapeForTag, isInt, isMuscle, isObj, onlyKeys, parseJsonText } from "./validate";
import { loadPrompt } from "../../prompts/load";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_BODY_BYTES = 32_768;
export const MAX_DAYS = 7;
export const MAX_ROUTINES = 14;
export const MAX_EXERCISES_PER_ROUTINE = 20;
export const MAX_DISLIKED = 100;
/** Ids from the app (day ids, routine ids) are short and plain. */
export const MAX_ID = 64;
export const MAX_DAY_NAME = 40;
export const MAX_REPS = 12;
/**
 * Longest "why" kept from the model; longer ones are replaced by the rule text.
 * Equal to cleanNote's cap, so a line is never cut short without anyone noticing.
 */
export const MAX_WHY = MAX_NOTE;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PRIORITIES = ["high", "medium", "low"] as const satisfies readonly Priority[];
const isPriority = (v: unknown): v is Priority => typeof v === "string" && (PRIORITIES as readonly string[]).includes(v);

/** Web or markup-like text in a model line ("http:", "www."). */
const LINK_LIKE = /https?:|www\.|\]\(|javascript:/i;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type OptimiseSplitInput = OptimiseInput;

export type OptimiseSplitResult = {
  /** "Lift noticed" lines: always the rules' own. */
  notes: string[];
  changes: Change[];
  emptied: MuscleGroup[];
  source: "ai" | "rules";
};

export type ValidateResult = { ok: true; input: OptimiseSplitInput } | { ok: false; error: string };

const INPUT_KEYS = ["goals", "split", "routines", "equipment"] as const;
const GOAL_KEYS = ["goalType", "experience", "sessionsPerWeek", "focusMuscles", "priorities", "targets", "limitations", "dislikedIds"] as const;

const isGoalType = (v: unknown): v is GoalType => typeof v === "string" && (GOAL_TYPES as readonly string[]).includes(v);
const isExperience = (v: unknown): v is Experience => typeof v === "string" && (EXPERIENCES as readonly string[]).includes(v);

/**
 * Strict shape check of the request body (already JSON-parsed). Unknown keys at
 * every level, wrong types, unknown muscles, limits, equipment and exercise ids,
 * over-long lists, odd ids and tag-like day names are rejected, never truncated.
 */
export function validateInput(raw: unknown, byId: ReadonlyMap<string, Exercise>): ValidateResult {
  const bad = (error: string): ValidateResult => ({ ok: false, error });
  if (!isObj(raw) || !onlyKeys(raw, INPUT_KEYS)) return bad("body");

  const g = raw.goals;
  if (!isObj(g) || !onlyKeys(g, GOAL_KEYS)) return bad("goals");
  if (!isGoalType(g.goalType)) return bad("goals.goalType");
  if (!isExperience(g.experience)) return bad("goals.experience");
  if (!isInt(g.sessionsPerWeek, 1, 7)) return bad("goals.sessionsPerWeek");

  const focusMuscles: MuscleGroup[] = [];
  const fm = g.focusMuscles ?? [];
  if (!Array.isArray(fm) || fm.length > MUSCLE_GROUPS.length) return bad("goals.focusMuscles");
  for (const m of fm) {
    if (!isMuscle(m)) return bad("goals.focusMuscles");
    if (!focusMuscles.includes(m)) focusMuscles.push(m);
  }

  const priorities: Partial<Record<MuscleGroup, Priority>> = {};
  if (g.priorities !== undefined && g.priorities !== null) {
    if (!isObj(g.priorities)) return bad("goals.priorities");
    for (const [k, v] of Object.entries(g.priorities)) {
      if (!isMuscle(k) || !isPriority(v)) return bad("goals.priorities");
      priorities[k] = v;
    }
  }

  const targets: Partial<Record<MuscleGroup, number>> = {};
  if (g.targets !== undefined && g.targets !== null) {
    if (!isObj(g.targets)) return bad("goals.targets");
    for (const [k, n] of Object.entries(g.targets)) {
      if (!isMuscle(k) || !isInt(n, 0, MAX_USER_TARGET)) return bad("goals.targets");
      targets[k] = n;
    }
  }

  const limitations: Limitation[] = [];
  const lim = g.limitations ?? [];
  if (!Array.isArray(lim) || lim.length > 6) return bad("goals.limitations");
  for (const l of lim) {
    if (!isLimitation(l)) return bad("goals.limitations");
    if (!limitations.includes(l)) limitations.push(l);
  }

  const dislikedIds: string[] = [];
  const dis = g.dislikedIds ?? [];
  if (!Array.isArray(dis) || dis.length > MAX_DISLIKED) return bad("goals.dislikedIds");
  for (const id of dis) {
    if (typeof id !== "string" || id.length > MAX_ID * 2 || !byId.has(id)) return bad("goals.dislikedIds");
    if (!dislikedIds.includes(id)) dislikedIds.push(id);
  }

  // Split.
  const s = raw.split;
  if (!isObj(s) || !onlyKeys(s, ["name", "days"])) return bad("split");
  if (s.name !== undefined && s.name !== "" && textField(s.name, MAX_DAY_NAME) === null) return bad("split.name");
  if (!Array.isArray(s.days) || s.days.length > MAX_DAYS) return bad("split.days");
  const days: { id: string; name: string; muscles: MuscleGroup[] }[] = [];
  for (const d of s.days) {
    if (!isObj(d) || !onlyKeys(d, ["id", "name", "muscles"])) return bad("split.days");
    if (typeof d.id !== "string" || !ID_RE.test(d.id) || days.some((x) => x.id === d.id)) return bad("split.days.id");
    const name = textField(d.name, MAX_DAY_NAME);
    if (name === null) return bad("split.days.name");
    if (!Array.isArray(d.muscles) || d.muscles.length > MUSCLE_GROUPS.length) return bad("split.days.muscles");
    const muscles: MuscleGroup[] = [];
    for (const m of d.muscles) {
      if (!isMuscle(m)) return bad("split.days.muscles");
      if (!muscles.includes(m)) muscles.push(m);
    }
    days.push({ id: d.id, name, muscles });
  }

  // Routines: ids and exercises only. Names are not needed and not accepted.
  const routines: PlanRoutine[] = [];
  const rs = raw.routines ?? [];
  if (!Array.isArray(rs) || rs.length > MAX_ROUTINES) return bad("routines");
  for (const r of rs) {
    if (!isObj(r) || !onlyKeys(r, ["id", "split_day_id", "exercises"])) return bad("routines");
    if (typeof r.id !== "string" || !ID_RE.test(r.id) || routines.some((x) => x.id === r.id)) return bad("routines.id");
    if (typeof r.split_day_id !== "string" || !ID_RE.test(r.split_day_id)) return bad("routines.split_day_id");
    if (!Array.isArray(r.exercises) || r.exercises.length > MAX_EXERCISES_PER_ROUTINE) return bad("routines.exercises");
    const exercises: PlanRoutine["exercises"][number][] = [];
    for (const e of r.exercises) {
      if (!isObj(e) || !onlyKeys(e, ["exercise_id", "target_sets", "target_reps"])) return bad("routines.exercises");
      if (typeof e.exercise_id !== "string" || e.exercise_id.length > MAX_ID * 2 || !byId.has(e.exercise_id)) return bad("routines.exercises.exercise_id");
      if (!isInt(e.target_sets, 1, 20)) return bad("routines.exercises.target_sets");
      if (typeof e.target_reps !== "string" || !/^[0-9]{1,3}([-–][0-9]{1,3})?s?$/.test(e.target_reps) || e.target_reps.length > MAX_REPS) return bad("routines.exercises.target_reps");
      exercises.push({ exercise_id: e.exercise_id, target_sets: e.target_sets, target_reps: e.target_reps });
    }
    routines.push({ id: r.id, name: "", split_day_id: r.split_day_id, exercises });
  }

  let equipment: Equipment[] = [];
  if (raw.equipment !== undefined && raw.equipment !== null) {
    const list = equipmentList(raw.equipment);
    if (list === null) return bad("equipment");
    equipment = list;
  }

  return {
    ok: true,
    input: {
      goals: { goalType: g.goalType, experience: g.experience, sessionsPerWeek: g.sessionsPerWeek, focusMuscles, priorities, targets, limitations, dislikedIds },
      split: { name: typeof s.name === "string" ? s.name : "", days },
      routines,
      catalogue: [],
      equipment,
    },
  };
}

// ---------------------------------------------------------------------------
// Context and rule answer
// ---------------------------------------------------------------------------

export type OptimiseContext = {
  input: OptimiseSplitInput;
  byId: ReadonlyMap<string, Exercise>;
  analysis: Analysis;
  proposals: Proposals;
  /** The rule-based answer: the fallback. */
  rule: OptimiseSplitResult;
};

export function ruleResponse(analysis: Analysis, proposals: Proposals): OptimiseSplitResult {
  return { notes: analysis.notes, changes: proposals.changes, emptied: proposals.emptied, source: "rules" };
}

/** Runs the rules on a validated body and the catalogue. */
export function buildContext(input: OptimiseSplitInput, catalogue: readonly Exercise[]): OptimiseContext {
  const byId = new Map<string, Exercise>();
  for (const e of catalogue) if (!byId.has(e.id)) byId.set(e.id, e);
  const full: OptimiseInput = { ...input, catalogue: [...byId.values()] };
  const analysis = analyseSplit(full);
  const proposals = proposeChanges(full);
  return { input: full, byId, analysis, proposals, rule: ruleResponse(analysis, proposals) };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = loadPrompt("optimise-split", { maxWhy: MAX_WHY });

/** JSON schema for structured output. Ids and text are enforced again in parseResponse. */
export const OPTIMISE_SCHEMA = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, why: { type: "string" } },
        required: ["id", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["changes"],
  additionalProperties: false,
} as const;

/** Data block the model sees. Only validated values, catalogue names and the app's own text go in. */
export function promptData(ctx: OptimiseContext) {
  const { goals } = ctx.input;
  const name = (id: string | null) => (id ? (ctx.byId.get(id)?.name ?? null) : null);
  return {
    goal_type: goals.goalType,
    experience: goals.experience,
    sessions_per_week: goals.sessionsPerWeek,
    priorities: goals.priorities ?? {},
    limitations: goals.limitations ?? [],
    // Day names are user text and are not sent as fields; days are numbered instead.
    split_days: ctx.input.split.days.map((d, i) => ({ day: i + 1, muscles: d.muscles })),
    analysis: ctx.analysis.rows.map((r) => ({ muscle: r.muscle, priority: r.priority, status: r.status, weekly_sets: r.weeklySets, target: r.target, direct_per_week: r.directPerWeek })),
    rule_findings: ctx.analysis.findings.map((f) => ({ muscle: f.muscle, severity: f.severity, message: f.message })),
    changes: ctx.proposals.changes.map((c) => ({
      id: c.id,
      kind: c.kind,
      muscle: c.muscle,
      exercise: name(c.exerciseId),
      replaces: name(c.replaceExerciseId),
      sets: c.sets,
      rule_why: c.why,
      evidence: c.evidenceIds.map((id) => evidenceById(id)?.claim).filter((x): x is string => !!x),
    })),
  };
}

export function buildPrompt(ctx: OptimiseContext): AiRequest {
  const data = escapeForTag(JSON.stringify(promptData(ctx)));
  return {
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `<user_data>\n${data}\n</user_data>\n\nOrder these proposed changes for this user and word each reason.`,
      },
    ],
    output_config: { effort: "low", format: { type: "json_schema", schema: OPTIMISE_SCHEMA as unknown as Record<string, unknown> } },
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** A safe plain line of at most `max` characters, or null. */
export function cleanText(v: unknown, max: number): string | null {
  // cleanNote cuts at MAX_NOTE, so a longer limit would let a cut line through.
  if (max > MAX_NOTE) throw new RangeError("cleanText limit above MAX_NOTE");
  if (typeof v !== "string" || v.length > max * 4) return null;
  const n = normaliseText(v);
  // Too long is rejected here: cleanNote would cut it short instead.
  if (n.length > max) return null;
  const s = cleanNote(n);
  if (s === null || s.length > max || isTagLike(s) || /[<>]/.test(s) || LINK_LIKE.test(s)) return null;
  return s;
}

/**
 * Validates and applies the model's JSON. Null when the answer is unusable (not
 * an object with a changes list, or no usable id). Otherwise the rule changes in
 * the model's order (unknown ids and repeats dropped), each with the model's
 * "why" when it is a clean line, else the rule text; changes the model left out
 * follow in rule order. Notes, exercises, sets, days and evidence are the rules'.
 */
export function parseResponse(json: unknown, ctx: OptimiseContext): OptimiseSplitResult | null {
  if (!isObj(json) || !Array.isArray(json.changes)) return null;
  const rule = new Map(ctx.proposals.changes.map((c) => [c.id, c]));

  const ordered: Change[] = [];
  const seen = new Set<string>();
  for (const raw of json.changes as unknown[]) {
    if (ordered.length >= MAX_CHANGES) break;
    if (!isObj(raw) || typeof raw.id !== "string") continue;
    const base = rule.get(raw.id);
    if (!base || seen.has(base.id)) continue;
    seen.add(base.id);
    ordered.push({ ...base, why: cleanText(raw.why, MAX_WHY) ?? base.why });
  }
  if (ordered.length === 0) return null;
  for (const c of ctx.proposals.changes) if (!seen.has(c.id)) ordered.push(c);

  return { notes: ctx.analysis.notes, changes: ordered, emptied: ctx.proposals.emptied, source: "ai" };
}

/** Parses the model's text, then applies it. Null on invalid JSON or an unusable answer. */
export function parseResponseText(text: string, ctx: OptimiseContext): OptimiseSplitResult | null {
  return parseResponse(parseJsonText(text), ctx);
}

/** The route's answer: the model's ordering and wording, or the rule answer when it is unusable. */
export function resolveResponse(text: string, ctx: OptimiseContext): OptimiseSplitResult {
  return parseResponseText(text, ctx) ?? ctx.rule;
}
