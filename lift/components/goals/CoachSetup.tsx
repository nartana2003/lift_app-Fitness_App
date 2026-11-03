"use client";

// "Set up with coach" (COACH-03): a step-by-step panel in the Goals section.
// 1) goal, experience and a typed goal (goals.note); 2) focus muscles and days a
// week; 3) the split (keep the current one or build one); 4) exercises per muscle
// of the split; 5) a review of the setup with suggested exercises.
//
// Nothing is saved until the final Save; Cancel discards. The AI routes
// (/api/ai/suggest-split, /api/ai/review-setup) are optional: on 503, offline or
// any failure the panel builds the split with buildSplit() from lib/splitBuilder.ts
// and the review with reviewSetup() from lib/coachReview.ts, both in the browser.
// Custom exercises are never sent to the routes.
//
// CO-05: the panel lives in Coach > Build a split. Inputs set in Priorities and
// limits (typed goals, muscle priorities, limits, never-suggest) and the saved
// favourites are used as they are, so only missing inputs are asked: the goal step
// is skipped when a goal is typed, and the focus chips give way to the priorities.
// The review drafts a routine per split day (rotation Day 1, Day 2 ..., never
// weekdays): POST /api/ai/generate-routines when it answers, the rule-based
// buildDayRoutines() otherwise, linked to the split day on Save.
import { useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "@/lib/muscles";
import { db } from "@/lib/offline/db";
import { EXPERIENCE_LABELS, GOAL_LABELS, goalsFingerprint, normalizeGoals, saveGoals, type Experience, type Goals, type GoalType } from "@/lib/goals";
import { ensureSplitDayIds, saveSplit, type Split } from "@/lib/splits";
import { routinesForDay } from "@/lib/splitRoutines";
import { allowedFor, type Limitation } from "@/lib/limitations";
import { createRoutine } from "@/lib/routines";
import { buildDayRoutines, MAX_PER_DAY as MAX_BUILD_PER_DAY, type DayPlan, type PlanItem } from "@/lib/coachBuild";
import { evidenceFor, knownEvidenceIds } from "@/lib/evidence/library";
import { searchExercises, type Exercise } from "@/lib/exercises";
import { useCatalogue } from "@/lib/catalogue";
import { toggleFavorite, useFavorites } from "@/lib/favorites";
import { equipmentForAi, useEquipment } from "@/lib/equipment";
import { isCustomId } from "@/lib/customExercises";
import { poolByMuscle } from "@/lib/pool";
import { suggestForMuscle } from "@/lib/suggest";
import { buildSplit, MAX_DAYS, MAX_NAME, MIN_DAYS } from "@/lib/splitBuilder";
import { reviewSetup } from "@/lib/coachReview";
import { EvidencePicks, MAX_EVIDENCE_MUSCLES } from "./EvidencePicks";
import { EvidenceList } from "../coach/EvidenceList";
import { ReplaceSheet } from "../coach/ReplaceSheet";
import {
  ROUTE as PLAN_ROUTE,
  MAX_SPLIT_DAYS,
  buildRequestBody as planRequestBody,
  hasTrainingDay,
  loadHistory,
  parsePlanIndexed,
  planDaysFor,
  type HistoryEntry,
  type PlanDay,
} from "../routines/GeneratePlan";

export const SPLIT_ROUTE = "/api/ai/suggest-split";
export const REVIEW_ROUTE = "/api/ai/review-setup";
/** Same cap as the review-setup route's goal note. */
export const MAX_NOTE = 300;
/** Same caps as the routes. */
export const MAX_FAVORITES = 30;
export const MAX_FOCUS = 8;
export const MAX_POOL_PER_MUSCLE = 40;
export const MAX_POOL_TOTAL = 300;
export const MAX_ADDITIONS = 8;
const MAX_USER_TARGET = 40;
const MAX_LINE = 200;
const SEARCH_RESULTS = 8;

export const MSG_AI_UNAVAILABLE = "AI is unavailable right now, so this uses the built-in rules.";
export const MSG_OFFLINE = "You are offline, so this uses the built-in rules.";
export const MSG_ALL_GOOD = "Your split and exercises cover your goals. Nothing needs fixing.";
export const MSG_ROUTINES_AI = "The coach picked these exercises for your split.";
export const MSG_ROUTINES_RULES = "These exercises come from the built-in rules.";

export const STEPS = ["What do you want", "Focus and days", "Your split", "Your exercises", "Review"] as const;

export type Draft = {
  goalType: GoalType;
  experience: Experience;
  note: string;
  focusMuscles: MuscleGroup[];
  sessionsPerWeek: number;
};

export type ReviewPick = { muscle: MuscleGroup; exercise: Exercise; reason: string };
export type ReviewView = { lines: string[]; picks: ReviewPick[]; source: "ai" | "rules" };

const isMuscle = (v: unknown): v is MuscleGroup => typeof v === "string" && (MUSCLE_GROUPS as readonly string[]).includes(v);
const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
const byMuscleOrder = (a: MuscleGroup, b: MuscleGroup) => MUSCLE_GROUPS.indexOf(a) - MUSCLE_GROUPS.indexOf(b);

/** Plain text line: control characters dropped, whitespace collapsed, length capped. */
function cleanText(v: unknown, max = MAX_LINE): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Catalogue ids only (custom exercises are never sent to the AI routes), unique, in order. */
export function catalogueIds(ids: readonly string[], max: number): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (out.length >= max) break;
    if (typeof id === "string" && !isCustomId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The typed goal, trimmed and capped, or "" when blank. */
export const trimNote = (note: string) => note.trim().slice(0, MAX_NOTE);

// ---------------------------------------------------------------------------
// Split step
// ---------------------------------------------------------------------------

/** Days a week for the split builder (it builds 2 to 6 days). */
export const splitDays = (sessionsPerWeek: number) => clampInt(sessionsPerWeek, MIN_DAYS, MAX_DAYS);

/** Body for POST /api/ai/suggest-split. */
export function splitRequestBody(draft: Draft, favorites: readonly string[], equipment: readonly Equipment[]) {
  const note = trimNote(draft.note);
  return {
    favorites: catalogueIds(favorites, MAX_FAVORITES),
    ...(note ? { request: note } : {}),
    days_per_week: splitDays(draft.sessionsPerWeek),
    equipment: equipmentForAi(equipment),
    goal_type: draft.goalType,
    experience: draft.experience,
    focus_muscles: [...new Set(draft.focusMuscles.filter(isMuscle))].slice(0, MAX_FOCUS),
  };
}

/** The rule-based split, built in the browser (same builder the route falls back to). */
export function ruleSplit(
  draft: Draft,
  favorites: readonly string[],
  byId: ReadonlyMap<string, Exercise>,
  equipment: readonly Equipment[],
): Split {
  const note = trimNote(draft.note);
  return buildSplit(
    {
      favorites: [...new Set(favorites)].filter((id) => byId.has(id)),
      request: note || null,
      days_per_week: splitDays(draft.sessionsPerWeek),
      equipment: equipmentForAi(equipment),
      goal_type: draft.goalType,
      experience: draft.experience,
      focus_muscles: [...new Set(draft.focusMuscles.filter(isMuscle))],
    },
    byId,
  ).split;
}

const WEEKDAY = /\b(mon|tues?|wed(nes)?|thu(rs?)?|fri|sat(ur)?|sun)(day)?\b/i;

/** A split is a rotation: a blank name or one that names a weekday becomes "Day N". */
export function rotationName(name: string, index: number): string {
  return name && !WEEKDAY.test(name) ? name : `Day ${index + 1}`;
}

/** Checks the route's split. Null when unusable. Muscles are filtered to MUSCLE_GROUPS. */
export function parseSplitAnswer(json: unknown): Split | null {
  if (typeof json !== "object" || json === null) return null;
  const s = (json as { split?: unknown }).split;
  if (typeof s !== "object" || s === null || !Array.isArray((s as { days?: unknown }).days)) return null;
  const days: Split["days"] = [];
  for (const d of (s as { days: unknown[] }).days) {
    if (days.length >= 7 || typeof d !== "object" || d === null) continue;
    const raw = (d as { muscles?: unknown }).muscles;
    const muscles = [...new Set((Array.isArray(raw) ? raw : []).filter(isMuscle))];
    if (muscles.length === 0) continue;
    days.push({ name: rotationName(cleanText((d as { name?: unknown }).name, MAX_NAME), days.length), muscles });
  }
  if (days.length === 0) return null;
  return { name: cleanText((s as { name?: unknown }).name, MAX_NAME) || "My split", days };
}

// ---------------------------------------------------------------------------
// Review step
// ---------------------------------------------------------------------------

export type PoolIds = Partial<Record<MuscleGroup, string[]>>;

/** Pool ids per muscle (from lib/pool.ts poolByMuscle), every muscle with at least one. */
export function poolIdsFor(ids: readonly string[], catalogue: readonly Exercise[], equipment: readonly Equipment[]): PoolIds {
  const pool = poolByMuscle(ids, catalogue, equipmentForAi(equipment));
  const out: PoolIds = {};
  for (const m of MUSCLE_GROUPS) if (pool[m].length) out[m] = pool[m].map((e) => e.id);
  return out;
}

/** Body for POST /api/ai/review-setup. Custom exercises are left out of the pool. */
export function reviewRequestBody(
  draft: Draft,
  targets: Goals["targets"],
  split: Split | null,
  pool: PoolIds,
  equipment: readonly Equipment[],
) {
  const own: Partial<Record<MuscleGroup, number>> = {};
  for (const [m, n] of Object.entries(targets ?? {})) {
    if (isMuscle(m) && typeof n === "number" && Number.isFinite(n)) own[m] = clampInt(n, 0, MAX_USER_TARGET);
  }
  const sentPool: PoolIds = {};
  let total = 0;
  for (const m of MUSCLE_GROUPS) {
    const ids = catalogueIds(pool[m] ?? [], Math.min(MAX_POOL_PER_MUSCLE, MAX_POOL_TOTAL - total));
    if (ids.length) {
      sentPool[m] = ids;
      total += ids.length;
    }
  }
  const days = (split?.days ?? []).filter((d) => d.muscles.length > 0).map((d) => ({ name: d.name, muscles: d.muscles }));
  const note = trimNote(draft.note);
  return {
    goals: {
      goalType: draft.goalType,
      experience: draft.experience,
      sessionsPerWeek: clampInt(draft.sessionsPerWeek, 1, 7),
      focusMuscles: [...new Set(draft.focusMuscles.filter(isMuscle))],
      targets: own,
      ...(note ? { note } : {}),
    },
    split: days.length ? { name: split!.name, days } : null,
    pool: sentPool,
    equipment: equipmentForAi(equipment),
  };
}

/** The COACH-01 review in the panel's shape: warnings first, then suggestions with reasons. */
export function ruleReview(
  draft: Draft,
  targets: Goals["targets"],
  split: Split | null,
  pool: PoolIds,
  catalogue: readonly Exercise[],
  equipment: readonly Equipment[],
): ReviewView {
  const review = reviewSetup({
    goals: { ...draft, targets },
    split: split ?? { name: "", days: [] },
    pool,
    catalogue,
    equipment: equipmentForAi(equipment),
  });
  const lines = [
    ...review.findings.filter((f) => f.severity === "warn"),
    ...review.findings.filter((f) => f.severity !== "warn"),
  ].map((f) => f.message);
  return {
    lines: lines.length ? lines : [MSG_ALL_GOOD],
    picks: review.suggestions.map((s) => ({ muscle: s.muscle, exercise: s.exercise, reason: s.reason })),
    source: "rules",
  };
}

/**
 * Checks the review-setup route's 200 body. Null when unusable. Additions must be
 * catalogue exercises (custom ids and unknown ids are dropped), never already in
 * the pool, not repeated, and at most MAX_ADDITIONS.
 */
export function parseReviewAnswer(
  json: unknown,
  get: (id: string) => Exercise | undefined,
  poolIds: ReadonlySet<string>,
): ReviewView | null {
  if (typeof json !== "object" || json === null) return null;
  const { summary, additions } = json as { summary?: unknown; additions?: unknown };
  if (!Array.isArray(summary)) return null;
  const lines = summary.map((l) => cleanText(l)).filter(Boolean).slice(0, 5);
  if (lines.length === 0) return null;
  const picks: ReviewPick[] = [];
  const seen = new Set<string>();
  for (const a of Array.isArray(additions) ? additions : []) {
    if (picks.length >= MAX_ADDITIONS || typeof a !== "object" || a === null) continue;
    const { exercise_id, muscle, reason } = a as Record<string, unknown>;
    if (typeof exercise_id !== "string" || isCustomId(exercise_id) || !isMuscle(muscle)) continue;
    const e = get(exercise_id);
    if (!e || seen.has(e.id) || poolIds.has(e.id)) continue;
    seen.add(e.id);
    picks.push({ muscle, exercise: e, reason: cleanText(reason) || `Exercise for ${muscle} that is not in your pool yet.` });
  }
  return { lines, picks, source: "ai" };
}

/** Muscles for the evidence search: focus muscles first, then the rest in order, capped. */
export function evidenceMusclesFor(muscles: readonly MuscleGroup[], focus: readonly MuscleGroup[]): MuscleGroup[] {
  const first = muscles.filter((m) => focus.includes(m));
  const rest = muscles.filter((m) => !focus.includes(m));
  return [...first, ...rest].slice(0, MAX_EVIDENCE_MUSCLES);
}

// ---------------------------------------------------------------------------
// Routines step (generate-routines)
// ---------------------------------------------------------------------------

export type AiPlan = { days: PlanDay[]; indices: number[] };

/**
 * Puts the generate-routines answer over the rule drafts. Plan day i is the
 * split's training day i (the route's order); repeats past the last training day
 * are ignored. An exercise is kept only when it is a catalogue exercise that
 * trains one of the day's muscles, fits the equipment, is not on the never-suggest
 * list and does not load a limit. A day left with nothing keeps its rule draft.
 * Null when the answer changed no day.
 */
export function mergeAiPlan(
  base: readonly DayPlan[],
  split: Split,
  ai: AiPlan,
  opts: {
    get: (id: string) => Exercise | undefined;
    equipment: readonly Equipment[];
    limitations: readonly Limitation[];
    dislikedIds: readonly string[];
  },
): DayPlan[] | null {
  const training = split.days
    .slice(0, MAX_SPLIT_DAYS)
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.muscles.some(isMuscle));
  const gear = opts.equipment.length ? new Set<string>(opts.equipment) : null;
  const disliked = new Set(opts.dislikedIds);
  const byDay = new Map<number, PlanDay>();
  ai.indices.forEach((pi, k) => {
    const t = training[pi];
    if (t && !byDay.has(t.i)) byDay.set(t.i, ai.days[k]);
  });

  let changed = false;
  const out = base.map((day) => {
    const answer = byDay.get(day.dayIndex);
    const muscles = split.days[day.dayIndex]?.muscles ?? [];
    if (!answer) return day;
    const items: PlanItem[] = [];
    for (const x of answer.exercises) {
      if (items.length >= MAX_BUILD_PER_DAY) break;
      const e = isCustomId(x.exercise_id) ? undefined : opts.get(x.exercise_id);
      if (!e || disliked.has(e.id) || (gear && !gear.has(e.equipment)) || !allowedFor(e, opts.limitations)) continue;
      if (items.some((it) => it.exercise_id === e.id)) continue;
      const muscle = e.muscle_groups.find((m) => muscles.includes(m));
      if (!muscle) continue;
      items.push({
        exercise_id: e.id,
        muscle,
        target_sets: x.target_sets,
        target_reps: x.target_reps,
        why: `The coach picked ${e.name} for ${muscle.toLowerCase()} on ${day.name}.`,
        evidenceIds: knownEvidenceIds(evidenceFor({ exerciseId: e.id }).map((v) => v.id)).slice(0, 2),
      });
    }
    if (items.length === 0) return day;
    changed = true;
    return { ...day, items };
  });
  return changed ? out : null;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

type Post = { kind: "ok"; json: unknown } | { kind: "offline" } | { kind: "failed" };

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

async function postJson(url: string, body: unknown): Promise<Post> {
  if (isOffline()) return { kind: "offline" };
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return { kind: "failed" };
    return { kind: "ok", json: await res.json() };
  } catch {
    return { kind: isOffline() ? "offline" : "failed" };
  }
}

const fallbackMessage = (p: Post) => (p.kind === "offline" ? MSG_OFFLINE : MSG_AI_UNAVAILABLE);

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

/** The Set up with coach button and, when open, the step-by-step panel. */
export function CoachSetup({ goals, split }: { goals: Goals; split: Split }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!open) {
    return (
      <div className="rounded-xl border border-border p-3">
        <div className="flex items-start justify-between gap-2">
          <span>
            <span className="block text-sm font-semibold">Coach setup</span>
            <span className="block text-xs text-muted">Goal, days a week, split and exercises, step by step.</span>
          </span>
          <button
            type="button"
            className="chip text-xs shrink-0"
            onClick={() => {
              setSaved(false);
              setOpen(true);
            }}
          >
            Set up with coach
          </button>
        </div>
        {saved && (
          <p role="status" className="text-xs text-muted mt-2">
            Coach setup saved.
          </p>
        )}
      </div>
    );
  }

  return (
    <CoachPanel
      goals={goals}
      split={split}
      onCancel={() => setOpen(false)}
      onSaved={() => {
        setSaved(true);
        setOpen(false);
      }}
    />
  );
}

type Stage = { draft: Draft; pendingSplit: Split | null; added: string[] };
type SplitMode = "current" | "build";
type Proposal = { split: Split; source: "ai" | "rules"; message: string | null };

function CoachPanel({
  goals,
  split,
  onCancel,
  onSaved,
}: {
  goals: Goals;
  split: Split;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const catalogue = useCatalogue();
  const favorites = useFavorites();
  const equipment = useEquipment();
  const hasSplit = split.days.length > 0;

  // Only missing inputs are asked: a typed goal means the goal step is already answered.
  const [step, setStep] = useState(goals.rankedGoals.length > 0 ? 1 : 0);
  const [draft, setDraft] = useState<Draft>(() => ({
    goalType: goals.goalType,
    experience: goals.experience,
    note: goals.note ?? "",
    focusMuscles: [...goals.focusMuscles],
    sessionsPerWeek: goals.sessionsPerWeek,
  }));
  const [pendingSplit, setPendingSplit] = useState<Split | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<Stage>({ draft, pendingSplit: null, added: [] });

  const [splitMode, setSplitMode] = useState<SplitMode>(hasSplit ? "current" : "build");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [building, setBuilding] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const [activeMuscle, setActiveMuscle] = useState<MuscleGroup | null>(null);
  const [query, setQuery] = useState("");

  const [review, setReview] = useState<ReviewView | null>(null);
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const reviewReq = useRef(0);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Draft routines for the days that have none, shown in the review step. They are
  // worked out from the review's stage and recomputed if the catalogue, favourites or
  // routines finish loading; the user's replacements sit on top, by day and place.
  const routines = useLiveQuery(() => db.routines.toArray(), []);
  const [reviewStage, setReviewStage] = useState<Stage | null>(null);
  const [replacements, setReplacements] = useState<Record<string, { exercise_id: string; why: string; evidenceIds: string[] }>>({});
  const [makeRoutines, setMakeRoutines] = useState(true);
  const [whyOpen, setWhyOpen] = useState<string | null>(null);
  const [replaceAt, setReplaceAt] = useState<{ day: number; item: number } | null>(null);
  // The generate-routines answer for the review's stage; ignored once the user has replaced an exercise.
  const [aiPlan, setAiPlan] = useState<{ stage: Stage; plan: AiPlan } | null>(null);
  const [planSource, setPlanSource] = useState<"ai" | "rules" | null>(null);
  const planReq = useRef(0);
  const replaced = useRef(false);

  const hasPriorities = Object.keys(goals.priorities).length > 0;
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const usedSplit: Split | null = pendingSplit ?? (hasSplit ? split : null);
  const poolSource = useMemo(() => [...new Set([...favorites, ...added])], [favorites, added]);
  const byId = useMemo(() => new Map(catalogue.exercises.map((e) => [e.id, e])), [catalogue.exercises]);
  const displayPool = useMemo(() => poolByMuscle(poolSource, catalogue.exercises, []), [poolSource, catalogue.exercises]);

  const basePlan = useMemo((): DayPlan[] => {
    const used = reviewStage ? (reviewStage.pendingSplit ?? (hasSplit ? split : null)) : null;
    if (!reviewStage || !used) return [];
    // A replaced split starts with no routines; a kept one skips days that already have one.
    const skip = new Set<number>();
    if (!reviewStage.pendingSplit) used.days.forEach((d, i) => routinesForDay(routines ?? [], d.id).length > 0 && skip.add(i));
    const gear = equipmentForAi(equipment);
    return buildDayRoutines({
      split: used,
      pool: poolByMuscle([...new Set([...favorites, ...reviewStage.added])], catalogue.exercises, gear),
      catalogue: catalogue.exercises,
      equipment: gear,
      limitations: goals.limitations,
      dislikedIds: goals.dislikedIds,
      goalType: reviewStage.draft.goalType,
      skipDays: skip,
    });
  }, [reviewStage, hasSplit, split, routines, favorites, catalogue.exercises, equipment, goals.limitations, goals.dislikedIds]);

  const draftPlan = useMemo((): DayPlan[] => {
    const used = reviewStage ? (reviewStage.pendingSplit ?? (hasSplit ? split : null)) : null;
    if (!aiPlan || aiPlan.stage !== reviewStage || !used) return basePlan;
    const gear = equipmentForAi(equipment);
    return mergeAiPlan(basePlan, used, aiPlan.plan, { get: catalogue.get, equipment: gear, limitations: goals.limitations, dislikedIds: goals.dislikedIds }) ?? basePlan;
  }, [aiPlan, reviewStage, hasSplit, split, basePlan, catalogue.get, equipment, goals.limitations, goals.dislikedIds]);

  const routinePlan = useMemo(
    () => draftPlan.map((d, di) => ({ ...d, items: d.items.map((it, ii) => ({ ...it, ...replacements[`${di}:${ii}`] })) })),
    [draftPlan, replacements],
  );

  const replaceItem = (day: number, item: number, e: Exercise) => {
    replaced.current = true;
    const old = routinePlan[day]?.items[item];
    setReplacements((r) => ({
      ...r,
      [`${day}:${item}`]: {
        exercise_id: e.id,
        why: `${e.name} is the replacement you chose for ${old ? (catalogue.get(old.exercise_id)?.name ?? "this exercise") : "this exercise"}.`,
        evidenceIds: evidenceFor({ exerciseId: e.id }).map((x) => x.id).slice(0, 2),
      },
    }));
    setReplaceAt(null);
  };

  const stepMuscles = useMemo(() => {
    const set = new Set<MuscleGroup>();
    for (const d of usedSplit?.days ?? []) for (const m of d.muscles) set.add(m);
    for (const m of draft.focusMuscles) set.add(m);
    return [...set].sort(byMuscleOrder);
  }, [usedSplit, draft.focusMuscles]);
  /** Muscles for the opt-in evidence search (COACH-05): focus muscles first, at most MAX_EVIDENCE_MUSCLES. */
  const evidenceMuscles = useMemo(
    () => evidenceMusclesFor(stepMuscles, draft.focusMuscles),
    [stepMuscles, draft.focusMuscles],
  );

  // ---- review ----

  const startReview = async (stage: Stage) => {
    const id = ++reviewReq.current;
    const ids = [...new Set([...favorites, ...stage.added])];
    const useSplitNow = stage.pendingSplit ?? (hasSplit ? split : null);
    const pool = poolIdsFor(ids, catalogue.exercises, equipment);
    const poolSet = new Set(Object.values(pool).flat());
    setReview(null);
    setReviewMsg(null);
    setReviewing(true);
    const res = await postJson(REVIEW_ROUTE, reviewRequestBody(stage.draft, goals.targets, useSplitNow, pool, equipment));
    if (id !== reviewReq.current) return;
    const ai = res.kind === "ok" ? parseReviewAnswer(res.json, catalogue.get, poolSet) : null;
    if (ai) {
      setReview(ai);
    } else {
      setReview(ruleReview(stage.draft, goals.targets, useSplitNow, pool, catalogue.exercises, equipment));
      setReviewMsg(fallbackMessage(res));
    }
    setReviewing(false);
  };

  // ---- routines ----

  /** Asks generate-routines for the review's split; the rule drafts stay on 503, offline or a bad answer. */
  const startPlan = async (stage: Stage) => {
    const id = planReq.current;
    const used = stage.pendingSplit ?? (hasSplit ? split : null);
    if (!used || !hasTrainingDay(used)) return;
    let history: HistoryEntry[] = [];
    try {
      history = await loadHistory();
    } catch {
      // No history is fine: the plan is built from the split alone.
    }
    const days = planDaysFor(used);
    const res = await postJson(PLAN_ROUTE, planRequestBody(used, equipment, history, { plan_days: days, favorites: [...favorites, ...stage.added] }));
    if (id !== planReq.current) return;
    const parsed = res.kind === "ok" && !replaced.current ? parsePlanIndexed(res.json, (x) => !isCustomId(x) && !!catalogue.get(x), days) : null;
    setAiPlan(parsed ? { stage, plan: parsed } : null);
    setPlanSource(parsed ? "ai" : "rules");
  };

  // ---- navigation ----

  const goTo = (to: number, stage: Stage) => {
    setSnapshot(stage);
    setActiveMuscle(null);
    setQuery("");
    setConfirmReplace(false);
    setStep(to);
    setReviewStage(to === STEPS.length - 1 ? stage : null);
    setReplacements({});
    setWhyOpen(null);
    setReplaceAt(null);
    planReq.current++;
    replaced.current = false;
    setAiPlan(null);
    setPlanSource(null);
    if (to === STEPS.length - 1) {
      void startReview(stage);
      void startPlan(stage);
    }
  };
  const current: Stage = { draft, pendingSplit, added };
  const next = () => goTo(Math.min(step + 1, STEPS.length - 1), current);
  const back = () => goTo(Math.max(step - 1, 0), current);
  /** Skip: undo this step's changes and move on. */
  const skip = () => {
    const restored: Stage = { ...current };
    if (step <= 1) restored.draft = snapshot.draft;
    if (step === 2) restored.pendingSplit = snapshot.pendingSplit;
    if (step === 3) restored.added = snapshot.added;
    setDraft(restored.draft);
    setPendingSplit(restored.pendingSplit);
    setAdded(restored.added);
    if (step === 2) {
      setProposal(null);
      setSplitMode(restored.pendingSplit || !hasSplit ? "build" : "current");
    }
    goTo(Math.min(step + 1, STEPS.length - 1), restored);
  };

  // ---- split ----

  const build = async () => {
    setBuilding(true);
    // Only the split on screen may be saved: a new build drops any earlier accepted proposal.
    setPendingSplit(null);
    setProposal(null);
    setConfirmReplace(false);
    const res = await postJson(SPLIT_ROUTE, splitRequestBody(draft, poolSource, equipment));
    const ai = res.kind === "ok" ? parseSplitAnswer(res.json) : null;
    setProposal(
      ai
        ? { split: ai, source: "ai", message: null }
        : { split: ruleSplit(draft, poolSource, byId, equipment), source: "rules", message: fallbackMessage(res) },
    );
    setBuilding(false);
  };

  const useProposal = () => {
    if (!proposal) return;
    if (hasSplit) setConfirmReplace(true);
    else setPendingSplit(proposal.split);
  };

  // ---- exercises ----

  const addExercise = (id: string) => setAdded((a) => (a.includes(id) || favorites.includes(id) ? a : [...a, id]));
  const removeAdded = (id: string) => setAdded((a) => a.filter((x) => x !== id));

  // ---- save ----

  /**
   * Records the goals this split was built for (so a later change can be noticed) and
   * creates the draft routines, each linked to its split day. Does nothing without a saved split.
   */
  const finishPlan = async () => {
    const stored = await ensureSplitDayIds();
    if (!stored || stored.days.length === 0) return;
    const fingerprint = goalsFingerprint(normalizeGoals((await db.meta.get("goals"))?.value as Partial<Goals> | undefined));
    const stamped = stored.builtFor === fingerprint ? stored : { ...stored, builtFor: fingerprint };
    if (stamped !== stored) await saveSplit(stamped);
    if (!makeRoutines) return;
    for (const d of routinePlan) {
      const dayId = stamped.days[d.dayIndex]?.id;
      if (!dayId || d.items.length === 0) continue;
      await createRoutine({
        name: d.name || stamped.days[d.dayIndex].name,
        exercises: d.items.map((i) => ({ exercise_id: i.exercise_id, target_sets: i.target_sets, target_reps: i.target_reps })),
        split_day_id: dayId,
      });
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await saveGoals({
        goalType: draft.goalType,
        experience: draft.experience,
        note: trimNote(draft.note),
        focusMuscles: draft.focusMuscles,
        sessionsPerWeek: clampInt(draft.sessionsPerWeek, 1, 7),
      });
      if (pendingSplit) await saveSplit(pendingSplit);
      await finishPlan();
      for (const id of added) if (!favorites.includes(id)) await toggleFavorite(id);
      onSaved();
    } catch {
      setSaveError("Could not save. Try again.");
      setSaving(false);
    }
  };

  const isLast = step === STEPS.length - 1;

  return (
    <section aria-label="Coach setup" className="rounded-xl border border-border p-3 space-y-3">
      <div>
        <p className="text-xs text-muted">
          Step {step + 1} of {STEPS.length}
        </p>
        <h3 className="text-sm font-semibold">{STEPS[step]}</h3>
      </div>

      {step === 0 && (
        <div className="space-y-3">
          <div>
            <p className="text-xs text-muted mb-1.5">Goal</p>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(GOAL_LABELS) as GoalType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={draft.goalType === t}
                  className={draft.goalType === t ? "chip-on justify-center py-2" : "chip justify-center py-2"}
                  onClick={() => patch({ goalType: t })}
                >
                  {GOAL_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted mb-1.5">Experience</p>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(EXPERIENCE_LABELS) as Experience[]).map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-pressed={draft.experience === e}
                  className={draft.experience === e ? "chip-on justify-center py-2" : "chip justify-center py-2"}
                  onClick={() => patch({ experience: e })}
                >
                  {EXPERIENCE_LABELS[e]}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="block text-xs text-muted mb-1.5">In your own words (optional)</span>
            <textarea
              className="field min-h-20"
              aria-label="Your goal in your own words"
              maxLength={MAX_NOTE}
              placeholder="e.g. Bigger shoulders and stronger legs"
              value={draft.note}
              onChange={(e) => patch({ note: e.target.value.slice(0, MAX_NOTE) })}
            />
            <span className="block text-[11px] text-muted text-right">
              {draft.note.length}/{MAX_NOTE}
            </span>
          </label>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          {hasPriorities ? (
            <div className="rounded-lg bg-surface-2 p-2 space-y-1 text-xs" aria-label="From Priorities and limits" role="group">
              <p>
                <span className="font-semibold">Muscle priorities: </span>
                {MUSCLE_GROUPS.filter((m) => goals.priorities[m])
                  .map((m) => `${m} ${goals.priorities[m]}`)
                  .join(", ")}
              </p>
              {goals.limitations.length > 0 && (
                <p>
                  <span className="font-semibold">Working around: </span>
                  {goals.limitations.join(", ")}
                </p>
              )}
              <p className="text-muted">Change these in Priorities and limits.</p>
            </div>
          ) : (
            <div>
              <p className="text-xs text-muted mb-1.5">Focus muscles: these get more sets</p>
              <div className="flex flex-wrap gap-1.5">
                {MUSCLE_GROUPS.map((m) => {
                  const on = draft.focusMuscles.includes(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={on}
                      className={on ? "chip-on text-xs" : "chip text-xs"}
                      onClick={() => patch({ focusMuscles: on ? draft.focusMuscles.filter((x) => x !== m) : [...draft.focusMuscles, m] })}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {favorites.length > 0 && (
            <p className="text-xs text-muted">
              Your {favorites.length} {favorites.length === 1 ? "favourite is" : "favourites are"} used first.
            </p>
          )}
          <label className="block">
            <span className="block text-xs text-muted mb-1.5">
              Days a week · <span data-testid="coach-days">{draft.sessionsPerWeek}</span>
            </span>
            <input
              type="range"
              min={1}
              max={7}
              aria-label="Days a week"
              value={draft.sessionsPerWeek}
              onChange={(e) => patch({ sessionsPerWeek: Number(e.target.value) })}
              className="w-full accent-[var(--accent)]"
            />
          </label>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {hasSplit && (
              <button
                type="button"
                aria-pressed={splitMode === "current"}
                className={splitMode === "current" ? "chip-on text-xs" : "chip text-xs"}
                onClick={() => {
                  setSplitMode("current");
                  setPendingSplit(null);
                  setConfirmReplace(false);
                }}
              >
                Use my current split
              </button>
            )}
            <button
              type="button"
              aria-pressed={splitMode === "build"}
              className={splitMode === "build" ? "chip-on text-xs" : "chip text-xs"}
              onClick={() => setSplitMode("build")}
            >
              Build one for me
            </button>
          </div>

          {splitMode === "current" && hasSplit && <SplitDays split={split} label="Your current split" />}
          {!hasSplit && splitMode === "build" && !proposal && (
            <p className="text-xs text-muted">You have no split yet. Build one from your goal, focus muscles and days a week.</p>
          )}

          {splitMode === "build" && (
            <div className="space-y-2">
              <button type="button" className="btn-ghost w-full py-2 text-sm" onClick={build} disabled={building}>
                {building ? "Building..." : proposal ? "Build again" : "Build split"}
              </button>
              {proposal && (
                <>
                  {proposal.message && (
                    <p role="status" className="text-xs text-muted">
                      {proposal.message}
                    </p>
                  )}
                  <SplitDays split={proposal.split} label="Proposed split" />
                  {pendingSplit === proposal.split ? (
                    <p role="status" className="text-xs text-muted">
                      This split will be saved when you tap Save.
                    </p>
                  ) : confirmReplace ? (
                    <div className="rounded-lg bg-surface-2 p-2 space-y-2">
                      <p className="text-xs">
                        This replaces your current split ({split.name || "My split"}). Your current split stays until you tap Save.
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="btn-primary flex-1 py-2 text-sm"
                          onClick={() => {
                            setPendingSplit(proposal.split);
                            setConfirmReplace(false);
                          }}
                        >
                          Replace split
                        </button>
                        <button type="button" className="btn-ghost flex-1 py-2 text-sm" onClick={() => setConfirmReplace(false)}>
                          Keep current
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="btn-primary w-full py-2 text-sm" onClick={useProposal}>
                      Use this split
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          {catalogue.loading && <p className="text-xs text-muted">Loading exercises...</p>}
          {stepMuscles.length === 0 ? (
            <p className="text-xs text-muted">Pick a split or focus muscles to see muscles here.</p>
          ) : (
            <ul className="space-y-2">
              {stepMuscles.map((m) => {
                const list = displayPool[m];
                const open = activeMuscle === m;
                const results = open
                  ? (query.trim()
                      ? searchExercises(catalogue.exercises, { muscle: m, q: query })
                      : suggestForMuscle(catalogue.exercises, m, catalogue.exercises.length)
                    )
                      .filter((e) => !list.some((x) => x.id === e.id))
                      .slice(0, SEARCH_RESULTS)
                  : [];
                return (
                  <li key={m} className="rounded-lg bg-surface-2 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold">{m}</span>
                      <button
                        type="button"
                        className="text-xs text-muted underline"
                        aria-label={`Add exercises for ${m}`}
                        onClick={() => {
                          setActiveMuscle(open ? null : m);
                          setQuery("");
                        }}
                      >
                        {open ? "Done" : "Add"}
                      </button>
                    </div>
                    {list.length === 0 ? (
                      <p className="text-xs text-muted">No starred exercises yet.</p>
                    ) : (
                      <ul className="mt-1 space-y-0.5">
                        {list.map((e) => (
                          <li key={e.id} className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate">{e.name}</span>
                            {added.includes(e.id) && (
                              <button type="button" className="text-muted underline shrink-0" aria-label={`Remove ${e.name}`} onClick={() => removeAdded(e.id)}>
                                Remove
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {open && (
                      <div className="mt-2 space-y-1">
                        <input
                          className="field py-1.5 bg-surface text-sm"
                          aria-label={`Search exercises for ${m}`}
                          placeholder="Search exercises"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                        {results.length === 0 ? (
                          <p className="text-xs text-muted">No matches.</p>
                        ) : (
                          <ul className="space-y-0.5">
                            {results.map((e) => (
                              <li key={e.id} className="flex items-center justify-between gap-2 text-xs">
                                <span className="truncate">{e.name}</span>
                                <button type="button" className="chip text-xs shrink-0" aria-label={`Add ${e.name}`} onClick={() => addExercise(e.id)}>
                                  Add
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-[11px] text-muted">Exercises you add are starred when you tap Save.</p>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-3">
          {reviewing && <p className="text-xs text-muted">Checking your setup...</p>}
          {reviewMsg && (
            <p role="status" className="text-xs text-muted">
              {reviewMsg}
            </p>
          )}
          {review && (
            <>
              <ul className="space-y-1" aria-label="Review">
                {review.lines.map((l, i) => (
                  <li key={i} className="text-sm">
                    {l}
                  </li>
                ))}
              </ul>
              {review.picks.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-muted">Suggested exercises</p>
                  {[...new Set(review.picks.map((p) => p.muscle))].map((m) => (
                    <div key={m} className="rounded-lg bg-surface-2 p-2">
                      <p className="text-sm font-semibold">{m}</p>
                      <ul className="space-y-1 mt-1">
                        {review.picks
                          .filter((p) => p.muscle === m)
                          .map((p) => {
                            const done = added.includes(p.exercise.id) || favorites.includes(p.exercise.id);
                            return (
                              <li key={p.exercise.id} className="flex items-start justify-between gap-2">
                                <span className="min-w-0">
                                  <span className="block text-xs font-semibold">{p.exercise.name}</span>
                                  <span className="block text-xs text-muted">{p.reason}</span>
                                </span>
                                <button
                                  type="button"
                                  className={done ? "chip-on text-xs shrink-0" : "chip text-xs shrink-0"}
                                  aria-label={done ? `${p.exercise.name} added` : `Add ${p.exercise.name}`}
                                  onClick={() => (done ? removeAdded(p.exercise.id) : addExercise(p.exercise.id))}
                                >
                                  {done ? "Added" : "Add"}
                                </button>
                              </li>
                            );
                          })}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {evidenceMuscles.length > 0 && (
            <EvidencePicks
              key={`${draft.goalType}|${draft.experience}|${draft.focusMuscles.join(",")}|${evidenceMuscles.join(",")}`}
              goals={{
                goalType: draft.goalType,
                experience: draft.experience,
                sessionsPerWeek: draft.sessionsPerWeek,
                focusMuscles: draft.focusMuscles,
              }}
              muscles={evidenceMuscles}
              equipment={equipment}
              isAdded={(id) => added.includes(id) || favorites.includes(id)}
              onAdd={addExercise}
              onRemove={removeAdded}
            />
          )}
          {routinePlan.length > 0 && (
            <section aria-label="Your routines" className="space-y-2">
              <p className="text-xs text-muted">Routines for the days that have none</p>
              {planSource && (
                <p role="status" className="text-xs text-muted">
                  {planSource === "ai" ? MSG_ROUTINES_AI : MSG_ROUTINES_RULES}
                </p>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={makeRoutines} onChange={(e) => setMakeRoutines(e.target.checked)} />
                Create these routines when I save
              </label>
              {routinePlan.map((d, di) => (
                <div key={d.dayIndex} className="rounded-lg bg-surface-2 p-2">
                  <p className="text-sm font-semibold">
                    {d.name.startsWith("Day ") ? "" : <span className="text-muted font-normal">Day {d.dayIndex + 1} · </span>}
                    {d.name}
                  </p>
                  <ul className="space-y-2 mt-1" aria-label={`${d.name} exercises`}>
                    {d.items.map((it, ii) => {
                      const key = `${di}-${ii}`;
                      const name = catalogue.get(it.exercise_id)?.name ?? it.exercise_id;
                      return (
                        <li key={key} className="text-xs">
                          <div className="flex items-start justify-between gap-2">
                            <span className="min-w-0">
                              <span className="block font-semibold">{name}</span>
                              <span className="block text-muted">
                                {it.muscle} · {it.target_sets} x {it.target_reps}
                              </span>
                            </span>
                            <span className="flex gap-1 shrink-0">
                              <button
                                type="button"
                                className={whyOpen === key ? "chip-on text-xs" : "chip text-xs"}
                                aria-expanded={whyOpen === key}
                                aria-label={`Why ${name} in ${d.name}`}
                                onClick={() => setWhyOpen(whyOpen === key ? null : key)}
                              >
                                Why
                              </button>
                              <button type="button" className="chip text-xs" aria-label={`Replace ${name} in ${d.name}`} onClick={() => setReplaceAt({ day: di, item: ii })}>
                                Replace
                              </button>
                            </span>
                          </div>
                          {whyOpen === key && (
                            <div className="mt-1 space-y-1">
                              <p>{it.why}</p>
                              <EvidenceList ids={it.evidenceIds} />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </section>
          )}
          {replaceAt && routinePlan[replaceAt.day]?.items[replaceAt.item] && catalogue.get(routinePlan[replaceAt.day].items[replaceAt.item].exercise_id) && (
            <ReplaceSheet
              current={catalogue.get(routinePlan[replaceAt.day].items[replaceAt.item].exercise_id)!}
              why={routinePlan[replaceAt.day].items[replaceAt.item].why}
              evidenceIds={routinePlan[replaceAt.day].items[replaceAt.item].evidenceIds}
              exclude={routinePlan[replaceAt.day].items.map((x) => x.exercise_id)}
              onClose={() => setReplaceAt(null)}
              onPick={(e) => replaceItem(replaceAt.day, replaceAt.item, e)}
            />
          )}
          {pendingSplit && <p className="text-xs text-muted">Your new split is saved when you tap Save.</p>}
          {saveError && (
            <p role="alert" className="text-xs text-bad">
              {saveError}
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-1" role="group" aria-label="Step navigation">
        <button type="button" className="btn-ghost flex-1 py-2 text-sm" onClick={back} disabled={step === 0}>
          Back
        </button>
        {!isLast && (
          <button type="button" className="btn-ghost flex-1 py-2 text-sm" onClick={skip}>
            Skip
          </button>
        )}
        {isLast ? (
          <button type="button" className="btn-primary flex-1 py-2 text-sm" onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
        ) : (
          <button type="button" className="btn-primary flex-1 py-2 text-sm" onClick={next}>
            Next
          </button>
        )}
      </div>
      <button type="button" className="text-xs text-muted underline" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}

function SplitDays({ split, label }: { split: Split; label: string }) {
  return (
    <div>
      <p className="text-xs text-muted mb-1">
        {label}
        {split.name ? `: ${split.name}` : ""}
      </p>
      <ul className="space-y-1" aria-label={label}>
        {split.days.map((d, i) => (
          <li key={i} className="rounded-lg bg-surface-2 px-2 py-1.5 text-xs">
            {!d.name.startsWith("Day ") && <span className="text-muted">Day {i + 1} · </span>}
            <span className="font-semibold">{d.name}</span>
            <span className="text-muted"> · {d.muscles.join(", ")}</span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted mt-1">A rotation, not weekdays: train the days in order on any dates, then start again at Day 1.</p>
    </div>
  );
}
