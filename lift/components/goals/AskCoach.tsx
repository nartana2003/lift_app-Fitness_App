"use client";

// "Ask the coach" (COACH-06): a collapsed card where the user types a question
// ("why is my bench stalling?") and gets a short plain answer from POST
// /api/ai/ask-coach, grounded in their own numbers: goals, this week's sets per
// muscle against the weekly targets, workouts in the last 4 weeks and recent
// sessions of a few exercises.
//
// Opt-in only: nothing is sent until Ask is tapped, and the request can be
// cancelled. On 503, offline or any failure it shows a plain message and, where
// one applies, a hint from the rule-based setup review (reviewSetup in
// lib/coachReview.ts). No citations or sources are shown or made up here.
// Custom exercises are never sent (the route only accepts catalogue ids).
import { useRef, useState } from "react";
import { Collapsible } from "@/components/Collapsible";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "@/lib/muscles";
import { allTargets, useGoals, type Goals } from "@/lib/goals";
import { useSplit, type Split } from "@/lib/splits";
import { useSettings } from "@/lib/settings";
import { useCatalogue } from "@/lib/catalogue";
import { useFavorites } from "@/lib/favorites";
import { useEquipment } from "@/lib/equipment";
import { isCustomId } from "@/lib/customExercises";
import { workoutsBetween } from "@/lib/history";
import { dayKey, periodStats, type WorkoutLite } from "@/lib/progress";
import { addDays, startOfWeek } from "@/lib/stats";
import { namedMuscles } from "@/lib/splitBuilder";
import { reviewSetup } from "@/lib/coachReview";
import { poolIdsFor } from "./CoachSetup";
import type { Exercise } from "@/lib/exercises";
import type { Unit } from "@/lib/units";

export const ASK_ROUTE = "/api/ai/ask-coach";

// Same caps as the route (lib/ai/ask-coach.ts; the tests check they match).
export const MAX_QUESTION = 500;
export const MAX_TURNS = 6;
export const MAX_TURN_TEXT = 1_300;
export const MAX_EXERCISES = 8;
export const MAX_SESSIONS = 8;
export const MAX_SETS_PER_SESSION = 10;
export const MAX_REPS = 100;
export const MAX_WEIGHT = 1_000;
export const MAX_WORKOUTS_28D = 56;
export const MAX_ANSWER_LINES = 5;
export const MAX_ANSWER_LINE = 240;
export const MAX_REFERENCED = 3;
/** Same bounds as lib/ai/goal-targets.ts. */
const MAX_WEEK_SETS = 200;
const MAX_USER_TARGET = 40;
/** Rule hints shown on the fallback path. */
export const MAX_HINTS = 3;
/** Days of history read for exercise sessions. */
export const HISTORY_DAYS = 56;

export const MSG_UNAVAILABLE = "The coach is not available right now.";
export const MSG_OFFLINE = "You are offline, so the coach cannot answer right now.";
export const MSG_FAILED = "Could not get an answer. Try again in a moment.";
export const MSG_TRUNCATED = "The answer was cut off. Try a shorter or more specific question.";
export const MSG_RATE_LIMITED = "The coach is busy. Try again in a minute.";
export const MSG_INVALID = "The coach could not read that question. Try rewording it.";
export const MSG_CANCELLED = "Cancelled.";
export const HINTS_TITLE = "From the built-in rules";

export type Turn = { role: "user" | "coach"; text: string };

export type CoachAnswer = {
  lines: string[];
  /** Names of the exercises the answer is about (only ones that were sent). */
  exercises: string[];
  source: "ai" | "rule";
};

const isMuscle = (v: unknown): v is MuscleGroup => typeof v === "string" && (MUSCLE_GROUPS as readonly string[]).includes(v);
const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/** Plain text: control characters dropped, whitespace collapsed, length capped. */
export function cleanLine(v: unknown, max = MAX_ANSWER_LINE): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The typed question, trimmed and capped, or "" when blank. */
export const trimQuestion = (q: string) => q.trim().slice(0, MAX_QUESTION);

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

type SetLite = { reps: number; weight: number; is_warmup?: boolean };
type SessionBody = { date: string; sets: { reps: number; weight: number; is_warmup?: true }[] };

const validSet = (s: SetLite) =>
  Number.isInteger(s.reps) && s.reps >= 0 && s.reps <= MAX_REPS && Number.isFinite(s.weight) && s.weight >= 0 && s.weight <= MAX_WEIGHT;

/**
 * Exercises to send: catalogue exercises from the workouts, the ones the
 * question names first, then the most recently done. Each with its last
 * MAX_SESSIONS sessions, oldest first, at most MAX_SETS_PER_SESSION valid sets
 * per session (one session per day, so dates never repeat).
 */
export function exerciseHistories(
  workouts: readonly WorkoutLite[],
  question: string,
  get: (id: string) => Exercise | undefined,
) {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const named = (e: Exercise) => {
    const n = e.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return n !== "" && q.includes(` ${n} `);
  };
  // exercise id -> date -> sets; plus the latest date per exercise.
  const byEx = new Map<string, Map<string, SetLite[]>>();
  const last = new Map<string, string>();
  for (const w of workouts) {
    if (!w.ended_at) continue;
    const date = dayKey(new Date(w.started_at));
    for (const x of w.exercises) {
      if (isCustomId(x.exercise_id) || !get(x.exercise_id)) continue;
      const sets = x.sets.filter(validSet);
      if (sets.length === 0) continue;
      let days = byEx.get(x.exercise_id);
      if (!days) byEx.set(x.exercise_id, (days = new Map()));
      days.set(date, [...(days.get(date) ?? []), ...sets]);
      if ((last.get(x.exercise_id) ?? "") < date) last.set(x.exercise_id, date);
    }
  }
  const ids = [...byEx.keys()].sort((a, b) => {
    const na = named(get(a)!) ? 1 : 0;
    const nb = named(get(b)!) ? 1 : 0;
    return nb - na || (last.get(b) ?? "").localeCompare(last.get(a) ?? "") || a.localeCompare(b);
  });
  return ids.slice(0, MAX_EXERCISES).map((id) => {
    const days = [...byEx.get(id)!.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-MAX_SESSIONS);
    const sessions: SessionBody[] = days.map(([date, sets]) => ({
      date,
      sets: sets
        .slice(0, MAX_SETS_PER_SESSION)
        .map((s) => (s.is_warmup ? { reps: s.reps, weight: s.weight, is_warmup: true as const } : { reps: s.reps, weight: s.weight })),
    }));
    return { exercise_id: id, sessions };
  });
}

/** This week's hard sets per muscle against the weekly target (every muscle). */
export function muscleWeek(
  workouts: readonly WorkoutLite[],
  goals: Goals,
  muscleOf: (id: string) => string[],
  weekStart: 0 | 1,
  now: Date,
) {
  const from = startOfWeek(now, weekStart);
  const stats = periodStats([...workouts], from, addDays(from, 7), muscleOf);
  const targets = allTargets(goals);
  return MUSCLE_GROUPS.map((m) => ({
    muscle: m,
    sets: clampInt(stats.sets_by_muscle[m] ?? 0, 0, MAX_WEEK_SETS),
    target: clampInt(targets[m] ?? 0, 0, MAX_USER_TARGET),
  }));
}

/** Finished workouts in the 28 days up to `now`. */
export function workoutsIn28Days(workouts: readonly WorkoutLite[], now: Date): number {
  const from = addDays(now, -28).getTime();
  const n = workouts.filter((w) => {
    const t = Date.parse(w.started_at);
    return !!w.ended_at && t >= from && t <= now.getTime();
  }).length;
  return Math.min(MAX_WORKOUTS_28D, n);
}

/** Earlier turns for the route: the last MAX_TURNS, each capped. */
export function historyTurns(turns: readonly Turn[]): Turn[] {
  return turns
    .map((t) => ({ role: t.role, text: cleanLine(t.text, MAX_TURN_TEXT) }))
    .filter((t) => t.text !== "")
    .slice(-MAX_TURNS);
}

export type AskInput = {
  question: string;
  unit: Unit;
  goals: Goals;
  workouts: readonly WorkoutLite[];
  get: (id: string) => Exercise | undefined;
  weekStart: 0 | 1;
  now: Date;
  turns: readonly Turn[];
};

/** Body for POST /api/ai/ask-coach. */
export function askRequestBody(input: AskInput) {
  const { question, unit, goals, workouts, get, weekStart, now, turns } = input;
  const muscleOf = (id: string) => get(id)?.muscle_groups ?? [];
  return {
    question: trimQuestion(question),
    unit,
    goal_type: goals.goalType,
    experience: goals.experience,
    sessions_per_week: clampInt(goals.sessionsPerWeek, 1, 7),
    workouts_28d: workoutsIn28Days(workouts, now),
    muscles: muscleWeek(workouts, goals, muscleOf, weekStart, now),
    exercises: exerciseHistories(workouts, question, get),
    history: historyTurns(turns),
  };
}

/** The smallest body the route accepts: used once when the full body is refused. */
export function minimalRequestBody(question: string, unit: Unit, goals: Goals) {
  return {
    question: trimQuestion(question),
    unit,
    goal_type: goals.goalType,
    experience: goals.experience,
    sessions_per_week: clampInt(goals.sessionsPerWeek, 1, 7),
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Checks the route's 200 body. Null when unusable. Lines are cleaned and capped;
 * exercise ids must be among the ids that were sent and are shown by name.
 */
export function parseAskAnswer(
  json: unknown,
  sentIds: ReadonlySet<string>,
  nameOf: (id: string) => string | undefined,
): CoachAnswer | null {
  if (typeof json !== "object" || json === null) return null;
  const { answer, exercise_ids, source } = json as Record<string, unknown>;
  if (!Array.isArray(answer)) return null;
  const lines: string[] = [];
  for (const l of answer) {
    const s = cleanLine(l);
    if (s && !lines.includes(s) && lines.length < MAX_ANSWER_LINES) lines.push(s);
  }
  if (lines.length === 0) return null;
  const exercises: string[] = [];
  for (const id of Array.isArray(exercise_ids) ? exercise_ids : []) {
    if (exercises.length >= MAX_REFERENCED || typeof id !== "string" || !sentIds.has(id)) continue;
    const name = nameOf(id);
    if (name && !exercises.includes(name)) exercises.push(name);
  }
  return { lines, exercises, source: source === "rule" ? "rule" : "ai" };
}

/** Plain message for a failed request. */
export function failureMessage(status: number, body: unknown): string {
  if (status === 503) return MSG_UNAVAILABLE;
  if (status === 400 || status === 413) return MSG_INVALID;
  if (status === 429) return MSG_RATE_LIMITED;
  if (typeof body === "object" && body !== null && (body as { error?: unknown }).error === "truncated") return MSG_TRUNCATED;
  return MSG_FAILED;
}

// ---------------------------------------------------------------------------
// Rule hints (fallback)
// ---------------------------------------------------------------------------

/**
 * Hints from the rule-based setup review for the fallback path. When the
 * question names muscles, only findings about those muscles (and whole-split
 * findings) count; otherwise the warnings. Muscle findings first, at most MAX_HINTS.
 */
export function ruleHints(input: {
  question: string;
  goals: Goals;
  split: Split;
  favorites: readonly string[];
  catalogue: readonly Exercise[];
  equipment: readonly Equipment[];
}): string[] {
  if (input.catalogue.length === 0) return [];
  const review = reviewSetup({
    goals: input.goals,
    split: input.split,
    pool: poolIdsFor(input.favorites, input.catalogue, input.equipment),
    catalogue: input.catalogue,
    equipment: input.equipment,
  });
  const named = namedMuscles(input.question).filter(isMuscle);
  const relevant = named.length
    ? review.findings.filter((f) => f.muscle === null || named.includes(f.muscle))
    : review.findings.filter((f) => f.severity === "warn");
  const ordered = [...relevant.filter((f) => f.muscle !== null), ...relevant.filter((f) => f.muscle === null)];
  const out: string[] = [];
  for (const f of ordered) if (out.length < MAX_HINTS && !out.includes(f.message)) out.push(f.message);
  return out;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "answer"; question: string; answer: CoachAnswer }
  | { kind: "fallback"; message: string; hints: string[] }
  | { kind: "cancelled" };

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** Finished workouts of the last HISTORY_DAYS days from the local store. */
export function loadRecentWorkouts(now = new Date()): Promise<WorkoutLite[]> {
  return workoutsBetween(addDays(now, -HISTORY_DAYS), addDays(now, 1));
}

const ICON = "M4 5h16v11H9l-5 4V5zM9 10h6M9 13h4";

/** Collapsed card: type a question, tap Ask, read a short plain answer. */
export function AskCoach({ loadWorkouts = loadRecentWorkouts }: { loadWorkouts?: (now: Date) => Promise<WorkoutLite[]> }) {
  const goals = useGoals();
  const split = useSplit();
  const { unit, weekStart } = useSettings();
  const catalogue = useCatalogue();
  const favorites = useFavorites();
  const equipment = useEquipment();

  const [question, setQuestion] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [turns, setTurns] = useState<Turn[]>([]);
  const ctrl = useRef<AbortController | null>(null);

  const hints = (q: string) =>
    ruleHints({ question: q, goals, split, favorites, catalogue: catalogue.exercises, equipment });

  const fallback = (message: string, q: string) => setState({ kind: "fallback", message, hints: hints(q) });

  const ask = async () => {
    const q = trimQuestion(question);
    if (!q || state.kind === "loading") return;
    if (isOffline()) {
      fallback(MSG_OFFLINE, q);
      return;
    }
    const ac = new AbortController();
    ctrl.current = ac;
    setState({ kind: "loading" });
    try {
      let workouts: WorkoutLite[] = [];
      try {
        workouts = await loadWorkouts(new Date());
      } catch {
        workouts = [];
      }
      if (ac.signal.aborted) return;
      const body = askRequestBody({ question: q, unit, goals, workouts, get: catalogue.get, weekStart, now: new Date(), turns });
      const post = (b: unknown) =>
        fetch(ASK_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b), signal: ac.signal });
      let sent = new Set(body.exercises.map((e) => e.exercise_id));
      let res = await post(body);
      // Something in the data or history was refused: ask once more with the question alone.
      if (res.status === 400 && (body.exercises.length > 0 || body.history.length > 0)) {
        sent = new Set();
        res = await post(minimalRequestBody(q, unit, goals));
      }
      if (!res.ok) {
        let errBody: unknown = null;
        try {
          errBody = await res.json();
        } catch {
          errBody = null;
        }
        if (ac.signal.aborted) return;
        fallback(failureMessage(res.status, errBody), q);
        return;
      }
      const parsed = parseAskAnswer(await res.json(), sent, (id) => catalogue.get(id)?.name);
      if (ac.signal.aborted) return;
      if (!parsed) {
        fallback(MSG_FAILED, q);
        return;
      }
      setState({ kind: "answer", question: q, answer: parsed });
      setQuestion("");
      if (parsed.source === "ai") {
        setTurns((t) => historyTurns([...t, { role: "user", text: q }, { role: "coach", text: parsed.lines.join(" ") }]));
      }
    } catch {
      if (ac.signal.aborted) return;
      fallback(isOffline() ? MSG_OFFLINE : MSG_FAILED, q);
    } finally {
      if (ctrl.current === ac) ctrl.current = null;
    }
  };

  const cancel = () => {
    ctrl.current?.abort();
    ctrl.current = null;
    setState({ kind: "cancelled" });
  };

  const startOver = () => {
    setTurns([]);
    setQuestion("");
    setState({ kind: "idle" });
  };

  const loading = state.kind === "loading";
  const canAsk = trimQuestion(question) !== "" && !loading;

  return (
    <Collapsible
      title="Ask the coach"
      subtitle="Questions about your training, answered from your own numbers"
      icon={
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d={ICON} />
        </svg>
      }
    >
      <p className="text-xs text-muted">
        Uses your goals, this week&apos;s sets and recent sessions. Nothing is sent until you tap Ask. General fitness information, not
        medical advice.
      </p>
      <label className="block">
        <span className="block text-xs text-muted mb-1.5">Your question</span>
        <textarea
          className="field min-h-20"
          aria-label="Your question for the coach"
          maxLength={MAX_QUESTION}
          placeholder="e.g. Why is my bench press stalling?"
          value={question}
          disabled={loading}
          onChange={(e) => setQuestion(e.target.value.slice(0, MAX_QUESTION))}
        />
        <span className="block text-[11px] text-muted text-right">
          {question.length}/{MAX_QUESTION}
        </span>
      </label>
      <div className="flex gap-2">
        {loading ? (
          <button type="button" className="btn-ghost flex-1 py-2 text-sm" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className="btn-primary flex-1 py-2 text-sm" onClick={ask} disabled={!canAsk} aria-disabled={!canAsk}>
            Ask
          </button>
        )}
        {turns.length > 0 && !loading && (
          <button type="button" className="btn-ghost py-2 px-3 text-sm" onClick={startOver}>
            Start over
          </button>
        )}
      </div>

      {loading && (
        <p role="status" className="text-xs text-muted">
          Asking the coach...
        </p>
      )}
      {state.kind === "cancelled" && (
        <p role="status" className="text-xs text-muted">
          {MSG_CANCELLED}
        </p>
      )}
      {state.kind === "fallback" && (
        <div className="space-y-2">
          <p role="status" className="text-xs text-muted">
            {state.message}
          </p>
          {state.hints.length > 0 && (
            <div className="rounded-lg bg-surface-2 p-2">
              <p className="text-xs text-muted mb-1">{HINTS_TITLE}</p>
              <ul className="space-y-1" aria-label={HINTS_TITLE}>
                {state.hints.map((h, i) => (
                  <li key={i} className="text-sm">
                    {h}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {state.kind === "answer" && (
        <section aria-label="Coach answer" className="space-y-2">
          <p className="text-xs text-muted">You asked: {state.question}</p>
          {state.answer.lines.map((l, i) => (
            <p key={i} className="text-sm">
              {l}
            </p>
          ))}
          {state.answer.exercises.length > 0 && <p className="text-xs text-muted">About: {state.answer.exercises.join(", ")}</p>}
          {state.answer.source === "rule" && <p className="text-xs text-muted">This answer comes from the built-in rules.</p>}
        </section>
      )}
    </Collapsible>
  );
}
