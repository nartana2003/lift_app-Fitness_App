/**
 * Client-safe, rule-based split builder (GEN-02). Pure: no I/O, no React, no
 * Dexie and nothing from lib/ai, so components can build a split offline or
 * when /api/ai/suggest-split answers 503. lib/ai/suggest-split.ts re-exports
 * everything here and uses buildSplit() as the route's fallback.
 *
 * Imports: lib/muscles at runtime, everything else as types only.
 */
import type { Exercise } from "./exercises";
import type { Experience, GoalType } from "./goals";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "./muscles";
import type { Split, SplitDay } from "./splits";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MIN_DAYS = 2;
export const MAX_DAYS = 6;
/** Days when neither days_per_week nor the request says otherwise. */
export const DEFAULT_DAYS = 3;
/** Same cap as split and day names in generate-routines. */
export const MAX_NAME = 40;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SuggestSplitInput = {
  /** Unique catalogue ids, in the order sent. */
  favorites: string[];
  /** Normalised request text, or null. */
  request: string | null;
  days_per_week: number | null;
  equipment: Equipment[];
  /** Optional goal settings. Absent means "not given"; the split is then built exactly as without them. */
  goal_type?: GoalType;
  experience?: Experience;
  /** Muscles to emphasise: each lands on two days (one day in a 2-day split). */
  focus_muscles?: MuscleGroup[];
};

export type SuggestSplitResult = {
  split: Split;
  notes: string | null;
  source: "ai" | "rules";
};

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * Loose key for any text: lower case, punctuation to spaces, simple plurals
 * folded. Same as textKey in lib/ai/social-import.ts (a test checks they agree);
 * copied because lib/ai is server-only.
 */
export function textKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length >= 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join(" ");
}

/** Extra words that point at a muscle group (textKey form, whole words). */
const MUSCLE_ALIASES: Partial<Record<MuscleGroup, string[]>> = {
  Quads: ["quad", "leg", "thigh"],
  Hamstrings: ["hamstring", "ham", "leg"],
  Glutes: ["glute", "butt", "leg"],
  Biceps: ["bicep", "arm"],
  Triceps: ["tricep", "arm"],
  Shoulders: ["shoulder", "delt", "delts"],
  "Abs/Core": ["ab", "core", "abdominal"],
  Lats: ["lat"],
  Calves: ["calf", "calve"],
  "Hips/Adductors/Abductors": ["hip", "adductor", "abductor"],
};

/** Words that negate the muscle term after them ("no legs", "skip chest", "nor arms"). textKey form. */
const NEGATORS = new Set([
  "no",
  "not",
  "skip",
  "skipping",
  "without",
  "except",
  "excluding",
  "exclude",
  "avoid",
  "avoiding",
  "nor",
  "minus",
]);

/** Words allowed between a negator and the muscle term ("no more legs", "don't want to train my legs"). */
const NEG_FILLERS = new Set([
  "any",
  "the",
  "my",
  "more",
  "extra",
  "much",
  "to",
  "do",
  "doing",
  "train",
  "training",
  "hit",
  "hitting",
  "work",
  "working",
  "on",
]);

/** Most filler words skipped between a negator and the term. */
const MAX_NEG_FILLERS = 3;

/** Whole-family terms only used to read negations ("no lower body"). */
const FAMILY_TERMS: { key: string; family: Family }[] = [
  { key: "leg", family: "legs" },
  { key: "lower body", family: "legs" },
];

type Hit = { muscles: MuscleGroup[]; family: Family | null; start: number; end: number };

/** Every muscle term in the text, by word position. `words` is textKey(text) split into words. */
function scanTerms(words: readonly string[]): Hit[] {
  const terms: { key: string[]; muscles: MuscleGroup[]; family: Family | null }[] = [];
  for (const m of MUSCLE_GROUPS) {
    for (const k of new Set([textKey(m), ...(MUSCLE_ALIASES[m] ?? [])])) terms.push({ key: k.split(" "), muscles: [m], family: null });
  }
  for (const t of FAMILY_TERMS) terms.push({ key: t.key.split(" "), muscles: [], family: t.family });
  const hits: Hit[] = [];
  for (let i = 0; i < words.length; i++) {
    for (const t of terms) {
      if (t.key.length === 0 || i + t.key.length > words.length) continue;
      if (t.key.every((w, j) => words[i + j] === w)) hits.push({ muscles: t.muscles, family: t.family, start: i, end: i + t.key.length });
    }
  }
  return hits;
}

/**
 * Whether the term starting at word `start` is negated: a negator ("no",
 * "not", "skip", "without", "except", "avoid", "don't want"...) right before
 * it, with at most MAX_NEG_FILLERS filler words between ("no more legs"), or an
 * "or" after a negated term ("no chest or arms").
 */
function negatedAt(words: readonly string[], byEnd: ReadonlyMap<number, Hit[]>, start: number, memo: Map<number, boolean>): boolean {
  const known = memo.get(start);
  if (known !== undefined) return known;
  memo.set(start, false);
  let j = start - 1;
  let skipped = 0;
  while (j >= 0 && skipped < MAX_NEG_FILLERS && NEG_FILLERS.has(words[j])) {
    j--;
    skipped++;
  }
  let out = false;
  if (j >= 0) {
    const w = words[j];
    if (NEGATORS.has(w)) out = true;
    else if (w === "want" && j >= 1) {
      // "don't want" (textKey: "don t want"), "dont want", "do not want", "won't want".
      const p = words[j - 1];
      out = p === "dont" || p === "not" || (p === "t" && j >= 2 && (words[j - 2] === "don" || words[j - 2] === "won"));
    } else if (w === "or") {
      out = (byEnd.get(j) ?? []).some((h) => negatedAt(words, byEnd, h.start, memo));
    }
  }
  memo.set(start, out);
  return out;
}

function readMuscles(text: string): { named: Set<MuscleGroup>; negated: Set<MuscleGroup> } {
  const words = textKey(text).split(" ").filter(Boolean);
  const hits = scanTerms(words);
  const memo = new Map<number, boolean>();
  const byEnd = new Map<number, Hit[]>();
  const byStart = new Map<number, Hit[]>();
  let maxTerm = 1;
  for (const h of hits) {
    byEnd.set(h.end, [...(byEnd.get(h.end) ?? []), h]);
    byStart.set(h.start, [...(byStart.get(h.start) ?? []), h]);
    maxTerm = Math.max(maxTerm, h.end - h.start);
  }
  const named = new Set<MuscleGroup>();
  const negated = new Set<MuscleGroup>();
  for (const h of hits) {
    // A term inside a longer negated term ("back" in "no lower back") is negated with it.
    // Terms are at most maxTerm words long, so only hits starting that close can contain h.
    let neg = negatedAt(words, byEnd, h.start, memo);
    for (let s = h.start - 1; !neg && s >= 0 && s > h.start - maxTerm; s--) {
      neg = (byStart.get(s) ?? []).some((o) => o.end >= h.end && negatedAt(words, byEnd, o.start, memo));
    }
    const ms = h.family ? MUSCLE_GROUPS.filter((m) => FAMILY[m] === h.family) : h.muscles;
    // Family terms ("lower body") only count when negated; "leg" also names muscles through MUSCLE_ALIASES.
    if (h.family && !neg) continue;
    for (const m of ms) (neg ? negated : named).add(m);
  }
  for (const m of named) negated.delete(m);
  return { named, negated };
}

/**
 * Muscle groups the text names. A negated mention ("no legs", "skip chest",
 * "without arms", "don't want abs") does not count.
 */
export function mentionedMuscles(question: string): MuscleGroup[] {
  const { named } = readMuscles(question);
  return MUSCLE_GROUPS.filter((m) => named.has(m));
}

/**
 * Muscle groups the request asks to leave out: negated mentions ("no legs"
 * drops the whole leg family), and every leg muscle for "only upper body",
 * "just upper", "upper body only". A muscle the request also names without a
 * negation is not excluded.
 */
export function excludedMuscles(request: string | null): MuscleGroup[] {
  if (!request) return [];
  const { named, negated } = readMuscles(request);
  const q = ` ${textKey(request)} `;
  if (/ (?:only|just) upper | upper (?:body )?only /.test(q)) {
    for (const m of MUSCLE_GROUPS) if (FAMILY[m] === "legs" && !named.has(m)) negated.add(m);
  }
  return MUSCLE_GROUPS.filter((m) => negated.has(m));
}

const WORD_DAYS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 };

/**
 * A day count written in the request ("4 days", "four days a week", "5x a
 * week"), when it is 2..6. Null otherwise.
 */
export function daysFromRequest(request: string | null): number | null {
  if (!request) return null;
  const m = /\b([2-6]|two|three|four|five|six)\s*(?:-\s*)?(?:days?|x\b|times?\b)/i.exec(request);
  if (!m) return null;
  const n = WORD_DAYS[m[1].toLowerCase()] ?? Number(m[1]);
  return n >= MIN_DAYS && n <= MAX_DAYS ? n : null;
}

// ---------------------------------------------------------------------------
// Muscles
// ---------------------------------------------------------------------------

type Family = "push" | "pull" | "legs" | "core";

/** Which kind of day each muscle belongs to. */
export const FAMILY: Record<MuscleGroup, Family> = {
  Chest: "push",
  Shoulders: "push",
  Triceps: "push",
  Back: "pull",
  Lats: "pull",
  Traps: "pull",
  "Lower back": "pull",
  Biceps: "pull",
  Forearms: "pull",
  Neck: "pull",
  Quads: "legs",
  Hamstrings: "legs",
  Glutes: "legs",
  "Hips/Adductors/Abductors": "legs",
  Calves: "legs",
  "Abs/Core": "core",
};

/** What the split covers when no favourites are given. */
export const DEFAULT_MUSCLES: readonly MuscleGroup[] = [
  "Chest",
  "Back",
  "Lats",
  "Shoulders",
  "Biceps",
  "Triceps",
  "Abs/Core",
  "Quads",
  "Hamstrings",
  "Glutes",
  "Calves",
];

/** Weight added to a muscle the request names or the goals focus on. */
const EMPHASIS = 3;

/**
 * How strongly each muscle is wanted: +2 per favourite whose primary muscle it
 * is, +1 per favourite that trains it secondarily, +3 when the request names
 * it. Only muscles with a primary favourite or a mention are kept (secondary
 * work alone does not add a muscle to the split).
 */
export function muscleWeights(favorites: readonly Exercise[], request: string | null): Map<MuscleGroup, number> {
  const w = new Map<MuscleGroup, number>();
  const keep = new Set<MuscleGroup>();
  const add = (m: MuscleGroup, n: number) => w.set(m, (w.get(m) ?? 0) + n);
  for (const e of favorites) {
    for (const m of e.muscle_groups) {
      add(m, 2);
      keep.add(m);
    }
    for (const m of e.secondary_groups ?? []) add(m, 1);
  }
  if (request) {
    for (const m of mentionedMuscles(request)) {
      add(m, EMPHASIS);
      keep.add(m);
    }
  }
  const out = new Map<MuscleGroup, number>();
  for (const m of MUSCLE_GROUPS) if (keep.has(m)) out.set(m, w.get(m) ?? 0);
  return out;
}

export const sortMuscles = (ms: Iterable<MuscleGroup>): MuscleGroup[] => {
  const set = new Set(ms);
  return MUSCLE_GROUPS.filter((m) => set.has(m));
};

/** Muscles named in the request plus focus muscles: each should land on two days. */
export function emphasisMuscles(input: SuggestSplitInput): MuscleGroup[] {
  return sortMuscles([...(input.request ? mentionedMuscles(input.request) : []), ...(input.focus_muscles ?? [])]);
}

/**
 * Every muscle the split must train: favourites' primary muscles, muscles the
 * request names and focus muscles.
 */
export function requiredMuscles(favorites: readonly Exercise[], input: SuggestSplitInput): MuscleGroup[] {
  return sortMuscles([...muscleWeights(favorites, input.request).keys(), ...(input.focus_muscles ?? [])]);
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** Label repeated day names A, B, C... so days are distinguishable. */
export function labelRepeats(days: SplitDay[]): SplitDay[] {
  const total = new Map<string, number>();
  for (const d of days) total.set(d.name, (total.get(d.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return days.map((d) => {
    if ((total.get(d.name) ?? 0) < 2) return d;
    const k = seen.get(d.name) ?? 0;
    seen.set(d.name, k + 1);
    const suffix = ` ${"ABCDEF"[k]}`;
    return { ...d, name: `${d.name.slice(0, MAX_NAME - suffix.length).trim()}${suffix}` };
  });
}

/** "Push / Pull / Legs" from the day names (A/B labels dropped), or "N-day split" when too long. */
export function splitName(days: SplitDay[]): string {
  const base: string[] = [];
  for (const d of days) {
    const n = d.name.replace(/ [A-F]$/, "");
    if (!base.includes(n)) base.push(n);
  }
  const joined = base.join(" / ");
  return joined.length <= MAX_NAME ? joined : `${days.length}-day split`;
}

type Unit = { name: string; muscles: MuscleGroup[] };

/**
 * Spread `n` days over `groups`: each group at least once (when n allows) and
 * at most ceil(n / groups) times, extra days going to the group with the most
 * weight per day it already has; then ordered so no group falls on two days
 * in a row when another group could go between them (always the group with
 * the most days left, skipping the one just placed).
 */
export function balanceDays<T>(groups: readonly T[], weights: readonly number[], n: number): T[] {
  if (groups.length === 0 || n <= 0) return [];
  const cap = Math.ceil(n / groups.length);
  const counts: number[] = groups.map((_, i) => (i < n ? 1 : 0));
  let total = counts.reduce((s, c) => s + c, 0);
  while (total < n) {
    let best = -1;
    let bestScore = -Infinity;
    counts.forEach((c, i) => {
      if (c >= cap) return;
      const score = weights[i] / (c + 1);
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    counts[best]++;
    total++;
  }
  const left = [...counts];
  const out: T[] = [];
  let prev = -1;
  for (let k = 0; k < n; k++) {
    const pick = (avoidPrev: boolean) => {
      let best = -1;
      left.forEach((c, i) => {
        if (c === 0 || (avoidPrev && i === prev)) return;
        if (best === -1 || c > left[best]) best = i;
      });
      return best;
    };
    let i = pick(true);
    if (i === -1) i = pick(false);
    left[i]--;
    out.push(groups[i]);
    prev = i;
  }
  return out;
}

/**
 * Rule-based split: no model, no key, deterministic.
 *
 * Muscles: with favourites, the muscles they train (see muscleWeights); with
 * no favourites, DEFAULT_MUSCLES, with extra weight on muscles the request
 * names and without the muscles it leaves out (excludedMuscles; favourites'
 * and focus muscles are never dropped). Focus muscles are always included.
 *
 * Days: the muscles are grouped into push, pull and legs days. Two days become
 * Upper / Lower, four days Upper / Lower twice, five days Push / Pull / Legs /
 * Upper / Lower. Any other count (three, six, or when a group is missing)
 * spreads the push / pull / legs groups present with balanceDays(): each group
 * at most ceil(n / groups) times and never on two days in a row when avoidable
 * (six days gives each twice). Abs/Core joins the leg days (or every other day
 * when there are none). Finally every focus muscle and every muscle the
 * request names is added to more days until it is on two days (one in a 2-day
 * split), same-family days first.
 */
export function buildSplit(input: SuggestSplitInput, byId: ReadonlyMap<string, Exercise>): SuggestSplitResult {
  const favorites = input.favorites.map((id) => byId.get(id)).filter((e): e is Exercise => !!e);
  const focus = sortMuscles(input.focus_muscles ?? []);
  let weights = muscleWeights(favorites, input.request);
  const favoured = weights.size > 0 || focus.length > 0;
  if (favorites.length === 0) {
    // No favourites: a normal split, with the named muscles emphasised on top and
    // the muscles the request leaves out ("no legs", "only upper body") dropped.
    const excluded = new Set(excludedMuscles(input.request));
    const kept = DEFAULT_MUSCLES.filter((m) => !excluded.has(m));
    const base = new Map<MuscleGroup, number>((kept.length > 0 ? kept : DEFAULT_MUSCLES).map((m) => [m, 1]));
    for (const [m, w] of weights) base.set(m, (base.get(m) ?? 0) + w);
    weights = base;
  }
  for (const m of focus) weights.set(m, (weights.get(m) ?? 0) + EMPHASIS);
  const muscles = sortMuscles(weights.keys());
  const weightOf = (m: MuscleGroup) => weights.get(m) ?? 0;
  const n = input.days_per_week ?? daysFromRequest(input.request) ?? DEFAULT_DAYS;

  const fam = (f: Family) => muscles.filter((m) => FAMILY[m] === f);
  const push = fam("push");
  const pull = fam("pull");
  const legs = fam("legs");
  const core = fam("core");
  const groupWeight = (u: Unit) => u.muscles.reduce((s, m) => s + weightOf(m), 0);

  const P: Unit = { name: "Push", muscles: push };
  const L: Unit = { name: "Pull", muscles: pull };
  const G: Unit = { name: "Legs", muscles: legs };
  const upper: Unit = { name: "Upper", muscles: sortMuscles([...push, ...pull]) };
  const lower: Unit = { name: "Lower", muscles: legs };
  const all3 = push.length > 0 && pull.length > 0 && legs.length > 0;
  const hasUpper = upper.muscles.length > 0;

  let units: Unit[];
  if (n === 2 && hasUpper && legs.length > 0) units = [upper, lower];
  else if (n === 4 && hasUpper && legs.length > 0) units = [upper, lower, upper, lower];
  else if (n === 5 && all3) units = [P, L, G, upper, lower];
  else {
    const base = [P, L, G].filter((u) => u.muscles.length > 0);
    if (base.length === 0) base.push({ name: "Core", muscles: core });
    // base has at most 3 groups; n = 2 with all three is handled by Upper / Lower above.
    units = balanceDays(base, base.map(groupWeight), n);
  }

  let days: SplitDay[] = units.map((u) => ({ name: u.name, muscles: [...u.muscles] }));
  // Abs/Core rides along with leg days, or every other day when there are none.
  if (core.length > 0 && !(days.length > 0 && days.every((d) => d.name === "Core"))) {
    const legDays = days.filter((d) => d.name === "Legs" || d.name === "Lower");
    const targets = legDays.length > 0 ? legDays : days.filter((_, i) => i % 2 === 0);
    for (const d of targets) d.muscles = sortMuscles([...d.muscles, ...core]);
  }

  // Emphasis: focus muscles and named muscles on two days (one in a 2-day split).
  const need = Math.min(days.length, days.length >= 3 ? 2 : 1);
  for (const m of emphasisMuscles(input)) {
    while (days.filter((d) => d.muscles.includes(m)).length < need) {
      const free = days
        .map((d, i) => ({ d, i, same: d.muscles.some((x) => FAMILY[x] === FAMILY[m]) ? 0 : 1 }))
        .filter(({ d }) => !d.muscles.includes(m))
        .sort((a, b) => a.same - b.same || a.d.muscles.length - b.d.muscles.length || a.i - b.i);
      free[0].d.muscles = sortMuscles([...free[0].d.muscles, m]);
    }
  }
  days = labelRepeats(days);

  const notes = favoured
    ? "Grouped from the muscles your favourite exercises and request focus on."
    : "A balanced starting split. Add favourite exercises to tailor it.";
  return { split: { name: splitName(days), days }, notes, source: "rules" };
}
