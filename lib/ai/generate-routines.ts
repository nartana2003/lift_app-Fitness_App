/**
 * Server-only pure logic for POST /api/ai/generate-routines.
 *
 * Split + equipment + workout history in, a 3-day plan out. Every exercise id
 * in the output is clamped to the built-in catalogue: invented ids, ids for
 * equipment the user does not have, and ids that do not train the day's
 * muscles are dropped, and thin days are topped up from rule-based picks
 * (lib/suggest.ts). Each plan day maps 1:1 onto createRoutine()'s input.
 *
 * Untrusted user text (day names) is validated against a narrow character set
 * and only ever reaches the prompt JSON-encoded inside a <user_data> block that
 * the system prompt declares to be data, never instructions.
 */
import type { AiRequest } from "./client";
import type { Exercise } from "../exercises";
import { EQUIPMENT, MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "../muscles";
import { suggestForMuscle } from "../suggest";
// Type-only imports: these modules are client modules, nothing runtime is pulled in.
import type { Split } from "../splits";
import type { RoutineExerciseInput, createRoutine } from "../routines";
import { loadPrompt } from "../../prompts/load";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_BODY_BYTES = 16_384;
export const PLAN_DAYS = 3;
export const MAX_SPLIT_DAYS = 7;
export const MAX_HISTORY = 100;
export const MAX_NAME = 40;
export const MIN_PER_DAY = 3;
export const MAX_PER_DAY = 8;
export const MAX_SETS = 6;
export const MAX_NOTE = 240;
const CANDIDATES_PER_MUSCLE = 6;
const MAX_CANDIDATES_PER_DAY = 40;
const DEFAULT_SETS = 3;
const DEFAULT_REPS = "8-12";

/** Letters, digits, spaces and a few punctuation marks. No quotes, brackets or newlines. */
const SAFE_NAME = /^[\p{L}\p{N} &/+\-().,]+$/u;
const ID_RE = /^[A-Za-z0-9_\-]{1,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type HistoryEntry = {
  exercise_id: string;
  /** How many sessions included this exercise. */
  sessions: number;
  best_weight?: number;
  best_reps?: number;
  /** YYYY-MM-DD */
  last_date?: string;
};

export type GenerateRoutinesInput = {
  split: Split;
  /** Equipment the user has. Empty means "no restriction". Bodyweight is always allowed. */
  equipment: Equipment[];
  history: HistoryEntry[];
};

export type ValidateResult = { ok: true; input: GenerateRoutinesInput } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));
const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isNum = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

function safeName(v: unknown): string | null {
  // Control characters (newlines, tabs, zero-width) are rejected, not cleaned up.
  if (typeof v !== "string" || /[\p{Cc}\p{Cf}]/u.test(v)) return null;
  const s = v.trim().replace(/ +/g, " ");
  if (s.length === 0 || s.length > MAX_NAME || !SAFE_NAME.test(s)) return null;
  return s;
}

/**
 * Strict shape check of the request body (already JSON-parsed). Unknown keys,
 * wrong types, out-of-range numbers and unsafe names are rejected; nothing is
 * coerced except trimming names.
 */
export function validateInput(raw: unknown): ValidateResult {
  const bad = (error: string): ValidateResult => ({ ok: false, error });
  if (!isObj(raw) || !onlyKeys(raw, ["split", "equipment", "history"])) return bad("body");

  const split = raw.split;
  if (!isObj(split) || !onlyKeys(split, ["name", "days"])) return bad("split");
  let splitName = "";
  if (split.name !== undefined && split.name !== "") {
    const n = safeName(split.name);
    if (n === null) return bad("split.name");
    splitName = n;
  }
  if (!Array.isArray(split.days) || split.days.length < 1 || split.days.length > MAX_SPLIT_DAYS) return bad("split.days");
  const days: Split["days"] = [];
  for (const d of split.days) {
    if (!isObj(d) || !onlyKeys(d, ["name", "muscles"])) return bad("split.days");
    const name = safeName(d.name);
    if (name === null) return bad("split.days.name");
    if (!Array.isArray(d.muscles) || d.muscles.length > MUSCLE_GROUPS.length) return bad("split.days.muscles");
    const muscles: MuscleGroup[] = [];
    for (const m of d.muscles) {
      if (typeof m !== "string" || !(MUSCLE_GROUPS as readonly string[]).includes(m)) return bad("split.days.muscles");
      if (!muscles.includes(m as MuscleGroup)) muscles.push(m as MuscleGroup);
    }
    days.push({ name, muscles });
  }
  if (!days.some((d) => d.muscles.length > 0)) return bad("split.days.muscles");

  const eq = raw.equipment ?? [];
  if (!Array.isArray(eq) || eq.length > EQUIPMENT.length) return bad("equipment");
  const equipment: Equipment[] = [];
  for (const e of eq) {
    if (typeof e !== "string" || !(EQUIPMENT as readonly string[]).includes(e)) return bad("equipment");
    if (!equipment.includes(e as Equipment)) equipment.push(e as Equipment);
  }

  const hist = raw.history ?? [];
  if (!Array.isArray(hist) || hist.length > MAX_HISTORY) return bad("history");
  const history: HistoryEntry[] = [];
  for (const h of hist) {
    if (!isObj(h) || !onlyKeys(h, ["exercise_id", "sessions", "best_weight", "best_reps", "last_date"])) return bad("history");
    if (typeof h.exercise_id !== "string" || !ID_RE.test(h.exercise_id)) return bad("history.exercise_id");
    if (!isInt(h.sessions, 0, 10_000)) return bad("history.sessions");
    const entry: HistoryEntry = { exercise_id: h.exercise_id, sessions: h.sessions };
    if (h.best_weight !== undefined) {
      if (!isNum(h.best_weight, 0, 2000)) return bad("history.best_weight");
      entry.best_weight = h.best_weight;
    }
    if (h.best_reps !== undefined) {
      if (!isInt(h.best_reps, 0, 1000)) return bad("history.best_reps");
      entry.best_reps = h.best_reps;
    }
    if (h.last_date !== undefined) {
      if (typeof h.last_date !== "string" || !DATE_RE.test(h.last_date)) return bad("history.last_date");
      entry.last_date = h.last_date;
    }
    history.push(entry);
  }

  return { ok: true, input: { split: { name: splitName, days }, equipment, history } };
}

// ---------------------------------------------------------------------------
// Context: day templates, allowed equipment, candidates
// ---------------------------------------------------------------------------

export type DayTemplate = { name: string; muscles: MuscleGroup[] };

/**
 * Turns any split into exactly 3 training days. Splits with fewer days repeat
 * (Upper / Lower becomes Upper A, Lower, Upper B); longer splits are merged
 * round-robin into 3 days. Days with no muscles are ignored.
 */
export function planDays(split: Split): DayTemplate[] {
  const src = split.days.filter((d) => d.muscles.length > 0);
  if (src.length === 0) return [];
  let out: DayTemplate[];
  if (src.length <= PLAN_DAYS) {
    out = Array.from({ length: PLAN_DAYS }, (_, i) => ({ name: src[i % src.length].name, muscles: [...src[i % src.length].muscles] }));
  } else {
    out = Array.from({ length: PLAN_DAYS }, () => ({ name: "", muscles: [] as MuscleGroup[] }));
    const names: string[][] = [[], [], []];
    src.forEach((d, i) => {
      const b = out[i % PLAN_DAYS];
      names[i % PLAN_DAYS].push(d.name);
      for (const m of d.muscles) if (!b.muscles.includes(m)) b.muscles.push(m);
    });
    out.forEach((b, i) => (b.name = names[i].join(" + ").slice(0, 60).trim()));
  }
  // Label repeated names A, B, C so the three routines are distinguishable.
  const total = new Map<string, number>();
  for (const d of out) total.set(d.name, (total.get(d.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return out.map((d) => {
    if ((total.get(d.name) ?? 0) < 2) return d;
    const k = seen.get(d.name) ?? 0;
    seen.set(d.name, k + 1);
    return { ...d, name: `${d.name} ${"ABC"[k]}` };
  });
}

export type PlanContext = {
  days: DayTemplate[];
  /** Null means every equipment type is allowed. */
  allowed: Set<Equipment> | null;
  byId: Map<string, Exercise>;
  /** Per plan day: catalogue exercises the model may choose from, best first. */
  candidates: Exercise[][];
  /** History entries whose id is in the catalogue. */
  history: HistoryEntry[];
};

export function equipmentOk(e: Exercise, allowed: Set<Equipment> | null): boolean {
  return !allowed || allowed.has(e.equipment);
}

export function buildContext(input: GenerateRoutinesInput, catalogue: Exercise[]): PlanContext {
  const byId = new Map(catalogue.map((e) => [e.id, e]));
  const allowed = input.equipment.length ? new Set<Equipment>([...input.equipment, "Bodyweight"]) : null;
  const usable = catalogue.filter((e) => equipmentOk(e, allowed));
  const history = input.history.filter((h) => byId.has(h.exercise_id));
  const days = planDays(input.split);

  const candidates = days.map((day) => {
    const out: Exercise[] = [];
    const add = (e: Exercise) => {
      if (out.length < MAX_CANDIDATES_PER_DAY && !out.some((x) => x.id === e.id)) out.push(e);
    };
    // Exercises the user already does for these muscles come first.
    const done = [...history].sort((a, b) => b.sessions - a.sessions);
    for (const h of done) {
      const e = byId.get(h.exercise_id)!;
      if (equipmentOk(e, allowed) && trainsDay(e, day)) add(e);
    }
    for (const m of day.muscles) for (const e of suggestForMuscle(usable, m, CANDIDATES_PER_MUSCLE)) add(e);
    return out;
  });

  return { days, allowed, byId, candidates, history };
}

function trainsDay(e: Exercise, day: DayTemplate): boolean {
  return e.muscle_groups.some((m) => day.muscles.includes(m));
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = loadPrompt("generate-routines", { minPerDay: MIN_PER_DAY, maxPerDay: MAX_PER_DAY, maxSets: MAX_SETS });

/** JSON schema for structured output. Ranges are enforced again in parseResponse. */
export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          exercises: {
            type: "array",
            items: {
              type: "object",
              properties: {
                exercise_id: { type: "string" },
                sets: { type: "integer" },
                reps: { type: "string" },
              },
              required: ["exercise_id", "sets", "reps"],
              additionalProperties: false,
            },
          },
          note: { type: "string" },
        },
        required: ["exercises", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["days"],
  additionalProperties: false,
} as const;

/** Data block the model sees. Only validated values and catalogue fields go in. */
export function promptData(ctx: PlanContext) {
  return {
    days: ctx.days.map((d, i) => ({
      day: i + 1,
      name: d.name,
      muscles: d.muscles,
      candidates: ctx.candidates[i].map((e) => ({ id: e.id, name: e.name, equipment: e.equipment, muscles: e.muscle_groups })),
    })),
    equipment: ctx.allowed ? [...ctx.allowed] : "any",
    history: ctx.history.map((h) => ({ ...h, name: ctx.byId.get(h.exercise_id)!.name })),
  };
}

/**
 * Escape characters that could close or open a tag. Names are already limited
 * to a safe set, so this is defence in depth.
 */
const escapeForTag = (json: string) => json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

export function buildPrompt(ctx: PlanContext): AiRequest {
  const data = escapeForTag(JSON.stringify(promptData(ctx)));
  return {
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `<user_data>\n${data}\n</user_data>\n\nDesign the 3-day plan for the days in the data.`,
      },
    ],
    output_config: { effort: "low", format: { type: "json_schema", schema: PLAN_SCHEMA as unknown as Record<string, unknown> } },
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export type PlanDay = {
  name: string;
  muscles: MuscleGroup[];
  notes: string | null;
  exercises: Required<RoutineExerciseInput>[];
};

export type GeneratedPlan = {
  days: PlanDay[];
  /** Model picks dropped (invented id, wrong equipment or muscle, duplicate) plus rule-based fills. */
  adjusted: number;
};

const REPS_RE = /^(\d{1,2})(?:-(\d{1,2}))?$/;
const TIMED_RE = /^(\d{1,3})s$/;

/** A valid rep target, normalised, or the default. */
export function cleanReps(v: unknown): string {
  if (typeof v !== "string") return DEFAULT_REPS;
  const s = v.trim().replace(/\s+/g, "").replace(/[\u2013\u2014]/g, "-");
  const t = TIMED_RE.exec(s);
  if (t) return Number(t[1]) >= 5 ? s : DEFAULT_REPS;
  const m = REPS_RE.exec(s);
  if (!m) return DEFAULT_REPS;
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  if (lo < 1 || hi < lo || hi > 50) return DEFAULT_REPS;
  return lo === hi ? String(lo) : `${lo}-${hi}`;
}

export function cleanSets(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_SETS;
  return Math.min(MAX_SETS, Math.max(1, Math.round(v)));
}

/** Plain short text: no control characters, no emojis, collapsed whitespace. */
export function cleanNote(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE)
    .trim();
  return s || null;
}

/** Top up a day to MIN_PER_DAY from its candidates, covering uncovered muscles first. */
function topUp(day: DayTemplate, picked: Required<RoutineExerciseInput>[], candidates: Exercise[], byId: Map<string, Exercise>): number {
  let added = 0;
  const has = (id: string) => picked.some((p) => p.exercise_id === id);
  const covered = () => new Set(picked.flatMap((p) => byId.get(p.exercise_id)?.muscle_groups ?? []));
  // First pass: one exercise per uncovered muscle, while under the minimum.
  for (const m of day.muscles) {
    if (picked.length >= MIN_PER_DAY) break;
    if (covered().has(m)) continue;
    const e = candidates.find((c) => !has(c.id) && c.muscle_groups.includes(m));
    if (e) {
      picked.push({ exercise_id: e.id, target_sets: DEFAULT_SETS, target_reps: DEFAULT_REPS });
      added++;
    }
  }
  for (const e of candidates) {
    if (picked.length >= MIN_PER_DAY) break;
    if (has(e.id)) continue;
    picked.push({ exercise_id: e.id, target_sets: DEFAULT_SETS, target_reps: DEFAULT_REPS });
    added++;
  }
  return added;
}

/** A plan built only from rules (no model). Also what an empty model answer clamps to. */
export function rulePlan(ctx: PlanContext): GeneratedPlan {
  return parseResponse({ days: ctx.days.map(() => ({ exercises: [], note: "" })) }, ctx) ?? { days: [], adjusted: 0 };
}

/**
 * Validates and clamps the model's JSON. Returns null when the shape is
 * unusable (not an object with a days array); otherwise always returns
 * exactly one entry per plan day with catalogue-only ids.
 */
export function parseResponse(json: unknown, ctx: PlanContext): GeneratedPlan | null {
  if (!isObj(json) || !Array.isArray(json.days)) return null;
  const modelDays: unknown[] = json.days;
  let adjusted = 0;
  const days = ctx.days.map((day, i): PlanDay => {
    const raw = modelDays[i];
    const picked: Required<RoutineExerciseInput>[] = [];
    const list = isObj(raw) && Array.isArray(raw.exercises) ? raw.exercises : [];
    for (const item of list) {
      const id = isObj(item) && typeof item.exercise_id === "string" ? item.exercise_id : null;
      const e = id ? ctx.byId.get(id) : undefined;
      if (
        !e ||
        !isObj(item) ||
        !equipmentOk(e, ctx.allowed) ||
        !trainsDay(e, day) ||
        picked.some((p) => p.exercise_id === e.id) ||
        picked.length >= MAX_PER_DAY
      ) {
        adjusted++;
        continue;
      }
      picked.push({ exercise_id: e.id, target_sets: cleanSets(item.sets), target_reps: cleanReps(item.reps) });
    }
    adjusted += topUp(day, picked, ctx.candidates[i], ctx.byId);
    return { name: day.name, muscles: day.muscles, notes: isObj(raw) ? cleanNote(raw.note) : null, exercises: picked };
  });
  return { days, adjusted };
}

/** Parses the model's text, then clamps it. Null on invalid JSON or unusable shape. */
export function parseResponseText(text: string, ctx: PlanContext): GeneratedPlan | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  return parseResponse(json, ctx);
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export type CreateRoutineInput = Parameters<typeof createRoutine>[0];

/** One createRoutine() input per plan day (source "ai"). Days with no exercises are skipped. */
export function planToRoutineInputs(plan: GeneratedPlan): CreateRoutineInput[] {
  return plan.days
    .filter((d) => d.exercises.length > 0)
    .map((d) => ({
      name: d.name,
      exercises: d.exercises.map((e) => ({ ...e })),
      source: "ai" as const,
      kind: "routine" as const,
      notes: d.notes ?? undefined,
    }));
}
