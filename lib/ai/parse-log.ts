/**
 * Server-only pure logic for POST /api/ai/parse-log.
 *
 * A typed or dictated workout line ("bench 3x8 at 60, squat 5x5 @ 100kg")
 * goes in; structured exercises and sets matched to catalogue ids come out.
 *
 * This route accepts genuine free text, so it is fenced harder than the
 * enum-only routes:
 * - The text has a hard length cap (MAX_TEXT characters, MAX_BODY_BYTES bytes),
 *   control and format characters are normalised away, and anything that
 *   looks like a markup tag ("<x", "</x", "<!", "<?") is rejected outright.
 * - The text reaches the prompt only JSON-encoded and escaped (escapeForTag)
 *   inside the single <user_data> block that the system prompt declares to be
 *   data only.
 * - Every exercise id the model returns is clamped to the candidate list the
 *   app sent (which is drawn from the catalogue); anything else falls back to
 *   the rule match of the model's name against those same candidates, or to
 *   no id at all.
 * - Every number is clamped: sets per exercise, exercises per log, reps and
 *   weight all have hard limits.
 *
 * The rule-based parser (ruleParse) needs no model: it reads the common
 * "3x8 at 60", "60kg x 8", "3 sets of 10", "8/8/6" shapes and matches names
 * with the existing lib/lyfta/match.ts matcher plus a short gym-shorthand
 * table. Candidates for the model come from the same matcher, so the model
 * only re-reads the text and picks among real catalogue ids.
 */
import type { AiRequest } from "./client";
import type { Exercise } from "../exercises";
import { matchExercise, tokens } from "../lyfta/match";
import { fromDisplay, type Unit } from "../units";
import { cleanNote } from "./generate-routines";
import { escapeForTag, isObj, onlyKeys, parseJsonText } from "./validate";
import { loadPrompt } from "../../prompts/load";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_BODY_BYTES = 8_192;
/** Longest text accepted, in characters (after normalising). */
export const MAX_TEXT = 1_000;
/** Exercises returned per log. */
export const MAX_EXERCISES = 20;
/** Sets kept per exercise. */
export const MAX_SETS = 20;
/** Reps per set. */
export const MAX_REPS = 100;
/** Heaviest load accepted, in kg (after unit conversion). */
export const MAX_WEIGHT_KG = 1_000;
/** Catalogue exercises offered to the model. */
export const MAX_CANDIDATES = 80;
/** Rule candidates gathered per exercise phrase. */
export const CANDIDATES_PER_PHRASE = 6;
/** Candidate ids returned per parsed exercise (for the preview's "change" list). */
export const MAX_ALTERNATES = 4;
/** Longest exercise name returned. */
export const MAX_NAME = 80;

export const UNITS = ["kg", "lb"] as const satisfies readonly Unit[];
// Compile-time checks in both directions: every entry is a Unit (satisfies,
// above) and every Unit in lib/units.ts is listed (below).
type _MissingUnit = Exclude<Unit, (typeof UNITS)[number]>;
const _unitsComplete: [_MissingUnit] extends [never] ? true : never = true;
void _unitsComplete;

const isUnit = (v: unknown): v is Unit => typeof v === "string" && (UNITS as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type ParseLogInput = {
  /** The workout text, normalised (see normaliseText). */
  text: string;
  /** Unit used when the text names none. */
  unit: Unit;
};

export type ValidateResult = { ok: true; input: ParseLogInput } | { ok: false; error: string };

/**
 * Anything that could open or close a markup tag. Workout text never needs one.
 * Whitespace and combining marks between the bracket and the next character
 * are skipped ("<́/x"), and the fullwidth and small-form lookalike
 * brackets are treated as "<" in case they survive normalising.
 * (Kept as the first layer; tagCheckForm + TAG_OPEN/TAG_CLOSE below are the
 * structural check.)
 */
const TAG_LIKE = /[<＜﹤][\s\p{M}]*[/!?a-z]/iu;

/** Variation selectors (a known way to hide text): U+FE00-FE0F and U+E0100-E01EF. */
const VARIATION_SELECTORS = /[︀-️\u{E0100}-\u{E01EF}]/gu;

/**
 * Invisible characters that are not Cf, M or whitespace: every
 * Default_Ignorable_Code_Point (soft hyphen, variation selectors, U+034F,
 * the Hangul fillers U+115F U+1160 U+3164 U+FFA0, tag characters...), plus
 * U+2800 BRAILLE PATTERN BLANK, which renders as a blank but is a symbol.
 * The fillers are listed explicitly as well in case an engine's property
 * table differs.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}⠀ᅟᅠㅤﾠ]/gu;

/**
 * Opening angle-bracket lookalikes that NFKD does not fold to "<": the ASCII
 * one, fullwidth and small-form (in case they survive), single and double
 * guillemet-style, CJK, mathematical, ornamental, Canadian syllabics,
 * modifier-letter arrowheads, presentation forms, "not less than" and the
 * left-pointing triangles.
 */
const OPEN_BRACKETS =
  "<＜﹤‹«〈〈《⟨⟪❬❮❰⧼ᐸ˂˱≮⋖︿︽◁◃⩹⪡";
/** The matching closing lookalikes. */
const CLOSE_BRACKETS =
  ">＞﹥›»〉〉》⟩⟫❭❯❱⧽ᐳ˃˲≯⋗﹀︾▷▹⩺⪢";

/**
 * Characters allowed to follow a bracket in workout text: digits, whitespace,
 * and the arithmetic and comparison punctuation of "< 20kg", "<3", "<=", "->",
 * "<<". Anything else (a letter in any script, "/", "!", "?", an emoji, a
 * slash lookalike, "_") makes the bracket tag-like. This is an allow list on
 * purpose: new lookalike letters or slashes cannot slip through.
 */
const AFTER_BRACKET_OK = "\\p{Nd}\\s=<>\\-+.,~()%*:;";
/** An opening bracket, optional whitespace, then anything not on the allow list. */
const TAG_OPEN = new RegExp(`[${OPEN_BRACKETS}]\\s*(?=[^${AFTER_BRACKET_OK}])`, "u");
/** A closing bracket immediately followed by anything not on the allow list (">user", ">/"). */
const TAG_CLOSE = new RegExp(`[${CLOSE_BRACKETS}](?=[^${AFTER_BRACKET_OK}])`, "u");

/**
 * The form the tag check runs on: NFKD (splits "≮" back into "<" + U+0338 and
 * folds compatibility lookalikes), every combining mark removed, every
 * invisible character removed. Never sent anywhere; only tested.
 */
export function tagCheckForm(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").replace(INVISIBLE, "").replace(/\p{Cf}/gu, "");
}

/** True when the text contains anything that could read as a markup tag. */
export function isTagLike(s: string): boolean {
  if (TAG_LIKE.test(s)) return true;
  const form = tagCheckForm(s);
  return TAG_OPEN.test(form) || TAG_CLOSE.test(form);
}

/**
 * NFKC (folds fullwidth and small-form lookalikes such as U+FF1C and U+FE64
 * to "<"), variation selectors removed, line endings to \n, tabs to spaces,
 * other control and format characters (zero-width, bidi overrides) removed,
 * runs of spaces collapsed, trimmed.
 */
export function normaliseText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(VARIATION_SELECTORS, "")
    .replace(INVISIBLE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\p{Cf}]/gu, "")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strict shape check of the request body (already JSON-parsed). Unknown keys,
 * empty or over-long text, tag-like text and unknown units are rejected.
 */
export function validateInput(raw: unknown): ValidateResult {
  const bad = (error: string): ValidateResult => ({ ok: false, error });
  if (!isObj(raw) || !onlyKeys(raw, ["text", "unit"])) return bad("body");
  if (typeof raw.text !== "string" || raw.text.length > MAX_TEXT * 2) return bad("text");
  const text = normaliseText(raw.text);
  if (text.length === 0 || text.length > MAX_TEXT) return bad("text");
  if (isTagLike(text)) return bad("text");
  const unit = raw.unit ?? "kg";
  if (!isUnit(unit)) return bad("unit");
  return { ok: true, input: { text, unit } };
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export type ParsedSet = {
  reps: number;
  /** Load in kg (the app stores kg). Null for bodyweight or when no weight was given. */
  weight_kg: number | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Reps as a whole number in 1..MAX_REPS, or null when unusable. */
export function clampReps(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const r = Math.round(v);
  if (r < 1) return null;
  return Math.min(r, MAX_REPS);
}

/** Weight in `unit` to kg, clamped to 0..MAX_WEIGHT_KG. Null for missing, zero-or-less or non-numbers. */
export function clampWeightKg(v: unknown, unit: Unit): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const kg = round2(fromDisplay(v, unit));
  // Rounding can turn a tiny weight (0.001) into 0: weights are null or > 0.
  if (!(kg > 0)) return null;
  return Math.min(kg, MAX_WEIGHT_KG);
}

// ---------------------------------------------------------------------------
// Rule matching (names)
// ---------------------------------------------------------------------------

/**
 * Gym shorthand the general matcher gets wrong or cannot read ("bench" alone
 * lands on Bench Dips, "ohp" matches nothing). Keys are written plainly and
 * compared after lib/lyfta/match.ts tokens(), so plurals are covered.
 */
export const SHORTHAND: Record<string, string> = {
  bench: "Barbell_Bench_Press_-_Medium_Grip",
  "bench press": "Barbell_Bench_Press_-_Medium_Grip",
  "flat bench": "Barbell_Bench_Press_-_Medium_Grip",
  "incline bench": "Barbell_Incline_Bench_Press_-_Medium_Grip",
  squat: "Barbell_Squat",
  "back squat": "Barbell_Squat",
  deadlift: "Barbell_Deadlift",
  dl: "Barbell_Deadlift",
  ohp: "Standing_Military_Press",
  "overhead press": "Standing_Military_Press",
  rdl: "Romanian_Deadlift",
  row: "Bent_Over_Barbell_Row",
  "barbell row": "Bent_Over_Barbell_Row",
  "bent over row": "Bent_Over_Barbell_Row",
  curl: "Barbell_Curl",
  "bicep curl": "Barbell_Curl",
  dip: "Parallel_Bar_Dip",
  pulldown: "Wide-Grip_Lat_Pulldown",
  "lat pulldown": "Wide-Grip_Lat_Pulldown",
  "calf raise": "Standing_Calf_Raises",
  lunge: "Barbell_Lunge",
};

const SHORT_KEYS: Map<string, string> = new Map(Object.entries(SHORTHAND).map(([k, id]) => [tokens(k).join(" "), id]));

export type MatchConfidence = "high" | "low" | "none";

export type NameMatch = {
  /** Best catalogue id, or null when nothing fits well enough. */
  exercise_id: string | null;
  confidence: MatchConfidence;
  /** Ranked catalogue ids (best first), at most CANDIDATES_PER_PHRASE. */
  candidates: string[];
};

/** Rule match of one exercise phrase against the catalogue. */
export function matchName(name: string, catalogue: Exercise[], byId: ReadonlyMap<string, Exercise>): NameMatch {
  const key = tokens(name).join(" ");
  if (!key) return { exercise_id: null, confidence: "none", candidates: [] };
  const r = matchExercise(name, catalogue, CANDIDATES_PER_PHRASE);
  const ranked = r.candidates.map((c) => c.exercise.id);
  const short = SHORT_KEYS.get(key);
  if (short && byId.has(short)) {
    return { exercise_id: short, confidence: "high", candidates: [short, ...ranked.filter((id) => id !== short)].slice(0, CANDIDATES_PER_PHRASE) };
  }
  if (!r.best || r.confidence === "none") return { exercise_id: null, confidence: "none", candidates: ranked };
  return { exercise_id: r.best.id, confidence: r.confidence === "review" ? "low" : "high", candidates: ranked };
}

// ---------------------------------------------------------------------------
// Rule parsing (numbers and phrases)
// ---------------------------------------------------------------------------

export type RuleSegment = {
  /** The exercise phrase with numbers and set words removed (may be empty). */
  name: string;
  unit: Unit;
  /** Raw sets: reps and weight in `unit`. */
  sets: { reps: number; weight: number | null }[];
};

const NUM = String.raw`\d+(?:\.\d+)?`;
const UNIT_WORD = String.raw`(?:kgs?|kilos?|kilograms?|lbs?|pounds?)`;
// No \b before the unit: "100kg" has no word boundary between "0" and "k".
const LB_RE = /(?<![a-z])(?:lbs?|pounds?)\b/i;
const KG_RE = /(?<![a-z])(?:kgs?|kilos?|kilograms?)\b/i;

/** Split text into exercise phrases: new lines, ";", and ",", "and", "then", "." before a word. */
export function splitSegments(text: string): string[] {
  return text
    .split(/\n|;|\s*,\s*(?=[a-z])|\s+(?:and|then)\s+(?=[a-z])|\.\s+(?=[a-z])/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse one phrase: "bench 3x8 at 60", "60kg x 8", "squat 3 sets of 5 @ 100", "curls 12/10/8". */
export function parseSegment(seg: string, defaultUnit: Unit): RuleSegment {
  let s = ` ${seg.toLowerCase()} `;
  const unit: Unit = LB_RE.test(s) ? "lb" : KG_RE.test(s) ? "kg" : defaultUnit;
  const sets: RuleSegment["sets"] = [];
  let weight: number | null = null;
  const cut = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    s = s.replace(re, (...args) => {
      fn(args.slice(0, -2) as unknown as RegExpExecArray);
      return " ";
    });
  };
  const push = (count: number, reps: number, w: number | null) => {
    const n = Math.max(1, Math.min(Math.round(count), MAX_SETS));
    for (let i = 0; i < n && sets.length < MAX_SETS; i++) sets.push({ reps, weight: w });
  };

  // "3x8x60": sets x reps x weight.
  cut(new RegExp(String.raw`(\d+)\s*[x×*]\s*(\d+)\s*[x×*]\s*(${NUM})\s*${UNIT_WORD}?`, "g"), (m) =>
    push(Number(m[1]), Number(m[2]), Number(m[3])),
  );
  // Weight: "at 60", "@ 60kg", "with 20", "60 kg".
  cut(new RegExp(String.raw`(?:@|\bat\b|\bwith\b)\s*(${NUM})\s*${UNIT_WORD}?`, "g"), (m) => {
    weight ??= Number(m[1]);
  });
  // "60kg x 8": weight with a unit, then reps.
  cut(new RegExp(String.raw`(${NUM})\s*${UNIT_WORD}\s*[x×*]\s*(\d+)`, "g"), (m) => push(1, Number(m[2]), Number(m[1])));
  cut(new RegExp(String.raw`(${NUM})\s*${UNIT_WORD}\b`, "g"), (m) => {
    weight ??= Number(m[1]);
  });
  // "3x8" (sets x reps) or "60x8" (weight x reps: a first number over 10 is a weight).
  const pairs: [number, number][] = [];
  cut(new RegExp(String.raw`(${NUM})\s*[x×*]\s*(\d+)`, "g"), (m) => pairs.push([Number(m[1]), Number(m[2])]));
  // "3 sets of 8", "3 sets x 8 reps".
  cut(/(\d+)\s*sets?\s*(?:of|x|×)?\s*(\d+)(?:\s*reps?)?/g, (m) => pairs.push([Number(m[1]), Number(m[2])]));
  for (const [a, b] of pairs) {
    if (Number.isInteger(a) && a <= 10) push(a, b, weight);
    else push(1, b, weight ?? a);
  }
  // "8/8/6" or "8, 8, 6": one set per number.
  cut(/(\d+(?:\s*[/,]\s*\d+)+)(?:\s*reps?)?/g, (m) => {
    for (const r of m[1].split(/[/,]/)) push(1, Number(r), weight);
  });
  // "10 reps".
  cut(/(\d+)\s*reps?\b/g, (m) => push(1, Number(m[1]), weight));

  const name = s
    .replace(/\d+(?:\.\d+)?/g, " ")
    .replace(new RegExp(String.raw`\b(?:${UNIT_WORD}|sets?|reps?|of|at|with|x|for|did|i|my)\b`, "g"), " ")
    .replace(/[@×*:=+\-–—,./()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { name, unit, sets: sets.filter((x) => x.reps >= 1) };
}

/**
 * Phrases with their sets. A phrase with no name (", 3x8" after "bench")
 * adds its sets to the phrase before it; a phrase with only a name and
 * nothing parsed is still kept, so "did some planks" lists the exercise.
 */
export function ruleSegments(text: string, defaultUnit: Unit): RuleSegment[] {
  const out: RuleSegment[] = [];
  for (const raw of splitSegments(text)) {
    const seg = parseSegment(raw, defaultUnit);
    const prev = out[out.length - 1];
    if (!seg.name) {
      if (prev && seg.sets.length) {
        for (const x of seg.sets) if (prev.sets.length < MAX_SETS) prev.sets.push(x);
      }
      continue;
    }
    if (out.length >= MAX_EXERCISES) break;
    out.push(seg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type ParseLogContext = {
  input: ParseLogInput;
  catalogue: Exercise[];
  byId: ReadonlyMap<string, Exercise>;
  /** Rule parse of the text, one entry per phrase. */
  segments: (RuleSegment & { match: NameMatch })[];
  /** Catalogue exercises the model may pick from (rule matches of every phrase). */
  candidates: Exercise[];
};

export function buildContext(input: ParseLogInput, catalogue: Exercise[]): ParseLogContext {
  const byId = new Map(catalogue.map((e) => [e.id, e]));
  const unit = isUnit(input.unit) ? input.unit : "kg";
  const segments = ruleSegments(typeof input.text === "string" ? input.text : "", unit).map((s) => ({
    ...s,
    match: matchName(s.name, catalogue, byId),
  }));
  const ids: string[] = [];
  for (const s of segments) for (const id of s.match.candidates) if (!ids.includes(id) && ids.length < MAX_CANDIDATES) ids.push(id);
  return { input, catalogue, byId, segments, candidates: ids.map((id) => byId.get(id)!).filter(Boolean) };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = loadPrompt("parse-log", { maxExercises: MAX_EXERCISES, maxSets: MAX_SETS });

const nullable = (t: "integer" | "number" | "string") => ({ anyOf: [{ type: t }, { type: "null" }] });

/** JSON schema for structured output. Ids, numbers and lengths are enforced again in parseResponse. */
export const PARSE_SCHEMA = {
  type: "object",
  properties: {
    exercises: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          exercise_id: nullable("string"),
          unit: { anyOf: [{ type: "string", enum: [...UNITS] }, { type: "null" }] },
          sets: {
            type: "array",
            items: {
              type: "object",
              properties: { reps: { type: "integer" }, weight: nullable("number") },
              required: ["reps", "weight"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "exercise_id", "unit", "sets"],
        additionalProperties: false,
      },
    },
  },
  required: ["exercises"],
  additionalProperties: false,
} as const;

/** Data block the model sees. Only validated text, the unit, fixed numbers and catalogue fields go in. */
export function promptData(ctx: ParseLogContext) {
  return {
    text: ctx.input.text,
    default_unit: ctx.input.unit,
    max_exercises: MAX_EXERCISES,
    max_sets_per_exercise: MAX_SETS,
    candidates: ctx.candidates.map((e) => ({ id: e.id, name: e.name, equipment: e.equipment, primary: e.muscle_groups })),
  };
}

export function buildPrompt(ctx: ParseLogContext): AiRequest {
  const data = escapeForTag(JSON.stringify(promptData(ctx)));
  return {
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `<user_data>\n${data}\n</user_data>\n\nParse the workout text into exercises and sets.`,
      },
    ],
    output_config: { effort: "low", format: { type: "json_schema", schema: PARSE_SCHEMA as unknown as Record<string, unknown> } },
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export type ParseSource = "ai" | "rule";

export type ParsedExercise = {
  /** Display name: the user's words, or the catalogue name when the user's words were unusable. */
  name: string;
  /** Catalogue id, or null when nothing matched (the preview asks the user to pick). */
  exercise_id: string | null;
  confidence: MatchConfidence;
  /** Other catalogue ids worth offering, best first. */
  alternates: string[];
  sets: ParsedSet[];
  source: ParseSource;
};

export type ParseLogResult = {
  exercises: ParsedExercise[];
  /** The default unit the text was read with. Weights are always returned in kg. */
  unit: Unit;
  /** Model values dropped or changed (ids, sets, names), plus a full rule fallback. */
  adjusted: number;
};

/** Exercise name: plain, short, no emojis, control characters or angle brackets. */
export function cleanName(v: unknown): string | null {
  const s = cleanNote(typeof v === "string" ? v.replace(/[<>]/g, " ") : v);
  return s ? s.slice(0, MAX_NAME).trim() || null : null;
}

const toSets = (raw: { reps: number; weight: number | null }[], unit: Unit): ParsedSet[] =>
  raw
    .map((x) => ({ reps: clampReps(x.reps), weight_kg: clampWeightKg(x.weight, unit) }))
    .filter((x): x is ParsedSet => x.reps !== null)
    .slice(0, MAX_SETS);

/** The text parsed by rules only (no model). */
export function ruleParse(ctx: ParseLogContext): ParseLogResult {
  const exercises: ParsedExercise[] = ctx.segments.slice(0, MAX_EXERCISES).map((s) => {
    const e = s.match.exercise_id ? ctx.byId.get(s.match.exercise_id) : undefined;
    return {
      name: cleanName(s.name) ?? e?.name ?? "Exercise",
      exercise_id: e?.id ?? null,
      confidence: e ? s.match.confidence : "none",
      alternates: s.match.candidates.filter((id) => id !== e?.id).slice(0, MAX_ALTERNATES),
      sets: toSets(s.sets, s.unit),
      source: "rule",
    };
  });
  return { exercises, unit: ctx.input.unit, adjusted: 0 };
}

/**
 * Validates and clamps the model's JSON. Returns null when the shape is
 * unusable (not an object with an exercises array). Otherwise:
 * - ids not in ctx.candidates fall back to the rule match of the item's name
 *   against ctx.candidates only (and to null when that finds nothing);
 *   alternates also come only from ctx.candidates,
 * - sets with unusable reps are dropped, reps and weights are clamped and
 *   weights converted to kg,
 * - items with neither a usable name nor an id are dropped, lists are capped.
 * An answer with no usable exercises gives the rule parse instead.
 */
export function parseResponse(json: unknown, ctx: ParseLogContext): ParseLogResult | null {
  if (!isObj(json) || !Array.isArray(json.exercises)) return null;
  // Every id and alternate must be one the app offered: the fallback rule
  // match runs against the candidates only, never the whole catalogue, so the
  // model's name cannot steer to an id the app never sent.
  const offered = ctx.candidates;
  const offeredById: ReadonlyMap<string, Exercise> = new Map(offered.map((e) => [e.id, e]));
  const allowed = offeredById;
  const exercises: ParsedExercise[] = [];
  let adjusted = 0;

  for (const item of json.exercises as unknown[]) {
    if (!isObj(item) || exercises.length >= MAX_EXERCISES) {
      adjusted++;
      continue;
    }
    const name = cleanName(item.name);
    const rawId = typeof item.exercise_id === "string" ? item.exercise_id.trim() : null;
    const ruled = name ? matchName(name, offered, offeredById) : null;

    let id: string | null = null;
    let confidence: MatchConfidence = "none";
    let source: ParseSource = "ai";
    if (rawId && allowed.has(rawId)) {
      id = rawId;
      confidence = "high";
    } else {
      if (rawId !== null || item.exercise_id !== null) adjusted++;
      if (ruled?.exercise_id) {
        id = ruled.exercise_id;
        confidence = ruled.confidence;
        source = "rule";
      }
    }
    const e = id ? offeredById.get(id) : undefined;
    const display = name ?? e?.name ?? null;
    if (!display) {
      adjusted++;
      continue;
    }

    const unit: Unit = isUnit(item.unit) ? item.unit : ctx.input.unit;
    const rawSets = Array.isArray(item.sets) ? (item.sets as unknown[]) : [];
    if (!Array.isArray(item.sets)) adjusted++;
    const sets: ParsedSet[] = [];
    for (const x of rawSets) {
      const reps = isObj(x) ? clampReps(x.reps) : null;
      if (reps === null || sets.length >= MAX_SETS) {
        adjusted++;
        continue;
      }
      if (isObj(x) && (x.reps !== reps || (x.weight !== null && clampWeightKg(x.weight, unit) === null))) adjusted++;
      sets.push({ reps, weight_kg: clampWeightKg((x as Record<string, unknown>).weight, unit) });
    }

    exercises.push({
      name: display,
      exercise_id: id,
      confidence,
      alternates: (ruled?.candidates ?? []).filter((c) => c !== id).slice(0, MAX_ALTERNATES),
      sets,
      source,
    });
  }

  if (exercises.length === 0) {
    const rule = ruleParse(ctx);
    return { ...rule, adjusted: adjusted + rule.exercises.length };
  }
  return { exercises, unit: ctx.input.unit, adjusted };
}

/** Parses the model's text, then clamps it. Null on invalid JSON or unusable shape. */
export function parseResponseText(text: string, ctx: ParseLogContext): ParseLogResult | null {
  const json = parseJsonText(text);
  return json === undefined ? null : parseResponse(json, ctx);
}
