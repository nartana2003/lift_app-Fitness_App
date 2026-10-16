// Matches an exercise name from another app (Lyfta) to our catalogue.
// Reads the equipment word ("Lever" = machine, "Cable", "Dumbbell"…) separately from the movement,
// so "Lever Seated Leg Curl" can land on "Seated Leg Curl". Tolerates typos, ignores "(male)"-style
// notes, and refuses to guess when most of the name isn't explained ("African Curls" ≠ "Barbell Curl").
import type { Exercise } from "../exercises";

const STOP = new Set(["for", "abs", "the", "with", "a", "an", "on", "of", "to", "and", "in", "version"]);

/** Words that describe a variant or body position, not the movement itself. They don't count for or against a match. */
const LIGHT = new Set(["medium", "grip", "powerlifting", "kneeling", "standing", "straight"]);

/** Words that describe equipment, mapped to the catalogue's equipment buckets. */
const EQUIP_BUCKET: Record<string, string> = {
  lever: "Machine/Cable",
  cable: "Machine/Cable",
  smith: "Machine/Cable",
  dumbbell: "Dumbbell",
  barbell: "Barbell",
  kettlebell: "Kettlebell",
  band: "Bands",
};

const SYNONYM: Record<string, string> = {
  leverage: "lever",
  machine: "lever",
  flye: "fly",
  flyes: "fly",
  flies: "fly",
  dumbbells: "dumbbell",
  barbells: "barbell",
  kettlebells: "kettlebell",
  bands: "band",
  bodyweight: "",
  "body-weight": "",
};

function stem(w: string): string {
  if (w.length <= 3) return w;
  if (/(ch|sh|ss|x)es$/.test(w)) return w.slice(0, -2);
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";
  if (/(ss|us|is)$/.test(w)) return w;
  return w.endsWith("s") ? w.slice(0, -1) : w;
}

export function tokens(name: string): string[] {
  const s = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // "(male)", "(high bar position)"
    .replace(/smith machine/g, "smith")
    .replace(/straight back/g, "straight")
    .replace(/lateral pull/g, "lat pull")
    .replace(/pull[\s-]?ups?/g, "pullup")
    .replace(/chin[\s-]?ups?/g, "chinup")
    .replace(/push[\s-]?ups?/g, "pushup")
    .replace(/sit[\s-]?ups?/g, "situp")
    .replace(/step[\s-]?ups?/g, "stepup")
    .replace(/[^a-z0-9]+/g, " ");
  const out: string[] = [];
  for (const raw of s.split(" ")) {
    if (!raw || STOP.has(raw)) continue;
    const mapped = raw in SYNONYM ? SYNONYM[raw] : stem(raw);
    const final = SYNONYM[mapped] ?? mapped;
    if (final) out.push(final);
  }
  return out;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Same word, allowing a typo in longer words ("zottomon" ≈ "zottman"). */
function sameToken(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5) return false;
  return editDistance(a, b) <= (Math.max(a.length, b.length) >= 8 ? 2 : 1);
}

/**
 * Names Lyfta (and similar apps) use for exercises our catalogue calls something quite different.
 * Key = tokens() of the foreign name. Review choices are remembered separately, so this only needs
 * the common ones.
 */
const ALIASES: Record<string, string> = {
  "lever seated fly": "Butterfly",
  "lever seated reverse fly": "Reverse Machine Flyes",
  "lever seated hip abduction": "Thigh Abductor",
  "lever seated hip adduction": "Thigh Adductor",
  "cable standing fly": "Cable Crossover",
  "bench press": "Barbell Bench Press - Medium Grip",
  "barbell bench press": "Barbell Bench Press - Medium Grip",
  "incline bench press": "Barbell Incline Bench Press - Medium Grip",
  "lateral raise": "Side Lateral Raise",
  "cable pushdown": "Triceps Pushdown",
  "hip thrust": "Barbell Hip Thrust",
  "dumbbell incline bench press": "Incline Dumbbell Press",
};

export type Candidate = { exercise: Exercise; score: number; recall: number };
export type Confidence = "exact" | "auto" | "review" | "none";
export type MatchResult = { confidence: Confidence; best?: Exercise; candidates: Candidate[] };

const norm = (s: string) => tokens(s).join(" ");

function score(q: string[], ex: Exercise): { score: number; recall: number } {
  const qEquip = new Set(q.filter((t) => t in EQUIP_BUCKET));
  const qCore = [...new Set(q.filter((t) => !(t in EQUIP_BUCKET) && !LIGHT.has(t)))];
  const c = tokens(ex.name);
  const cCore = [...new Set(c.filter((t) => !(t in EQUIP_BUCKET) && !LIGHT.has(t)))];
  if (qCore.length === 0 || cCore.length === 0) return { score: 0, recall: 0 };

  const overlap = qCore.filter((t) => cCore.some((u) => sameToken(t, u))).length;
  const precision = overlap / cCore.length;
  const recall = overlap / qCore.length;
  const f = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const cEquip = new Set(c.filter((t) => t in EQUIP_BUCKET));
  let equip = 0;
  if (qEquip.size) {
    const buckets = new Set([...qEquip].map((t) => EQUIP_BUCKET[t]));
    const sameWord = [...qEquip].some((t) => cEquip.has(t));
    // A plain machine exercise ("Leg Press") is the ideal home for "Lever Seated Leg Press".
    const genericInBucket = cEquip.size === 0 && buckets.has(ex.equipment);
    // If the movement matches fully, a different piece of equipment is only a small knock ("Band Face Pull" → "Face Pull").
    const mismatch = recall >= 0.99 ? -0.12 : -0.3;
    equip = sameWord ? 0.25 : genericInBucket ? 0.2 : buckets.has(ex.equipment) ? 0.05 : mismatch;
  }
  // A name that adds equipment the query never mentioned ("… With Bands", "Smith Machine …") is a variant.
  for (const t of cEquip) if (!qEquip.has(t)) equip -= 0.1;
  return { score: Math.min(1, Math.max(0, f * 0.85 + equip)), recall };
}

function rank(q: string[], catalogue: Exercise[], limit: number): Candidate[] {
  return catalogue
    .map((exercise) => ({ exercise, ...score(q, exercise) }))
    .filter((c) => c.score > 0.2)
    .sort((a, b) => b.score - a.score || a.exercise.name.length - b.exercise.name.length)
    .slice(0, limit);
}

/** Rank catalogue exercises for a foreign exercise name. */
export function matchExercise(name: string, catalogue: Exercise[], limit = 4): MatchResult {
  const q = tokens(name);
  const key = q.join(" ");
  const exact = catalogue.find((e) => norm(e.name) === key || (!!e.original_name && norm(e.original_name) === key));
  if (exact) return { confidence: "exact", best: exact, candidates: [{ exercise: exact, score: 1, recall: 1 }] };

  const alias = ALIASES[key] && catalogue.find((e) => (e.original_name ?? e.name) === ALIASES[key]);
  if (alias) {
    const others = rank(q, catalogue, limit + 1).filter((c) => c.exercise.id !== alias.id);
    return { confidence: "auto", best: alias, candidates: [{ exercise: alias, score: 0.95, recall: 1 }, ...others].slice(0, limit) };
  }

  const ranked = rank(q, catalogue, limit);
  const [top, second] = ranked;
  if (!top || top.score < 0.45) return { confidence: "none", candidates: ranked };

  // Most of the name isn't explained by this candidate → it's probably a different exercise.
  // Keep it as a suggestion the user can pick, but don't pre-select it.
  if (top.recall < 0.66 && top.score < 0.85) return { confidence: "none", candidates: ranked };

  // Only call it safe when the candidate adds nothing the query did not say.
  const tc = tokens(top.exercise.name).filter((t) => !LIGHT.has(t));
  const sameWords = tc.length === q.length && tc.every((t) => q.some((u) => sameToken(t, u)));
  const margin = top.score - (second?.score ?? 0);
  return { confidence: sameWords && margin >= 0.12 ? "auto" : "review", best: top.exercise, candidates: ranked };
}
