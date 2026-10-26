"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useCatalogue } from "@/lib/catalogue";
import { exerciseSessions, loggedExercises } from "@/lib/history";
import { detectPlateau, type Plateau } from "@/lib/plateau";
import { swapOptions } from "@/lib/swap";
import { useSettings } from "@/lib/settings";
import { fmtWeight, type Unit } from "@/lib/units";
import { db } from "@/lib/offline/db";
import { equipmentForAi, getEquipment } from "@/lib/equipment";
import { GOAL_LABELS, type GoalType } from "@/lib/goals";
import { listRoutines, updateRoutine, type RoutineExerciseInput } from "@/lib/routines";
import type { Equipment } from "@/lib/muscles";

const DISMISS_KEY = "plateau_dismissed";

/** Lifts that have stopped improving, with something to try. */
export function PlateauCard() {
  const { get, exercises } = useCatalogue();
  const { unit } = useSettings();
  const [open, setOpen] = useState<string | null>(null);

  const dismissedRaw = useLiveQuery(async () => ((await db.meta.get(DISMISS_KEY))?.value as string[] | undefined) ?? [], []);
  const dismissed = useMemo<string[]>(() => dismissedRaw ?? [], [dismissedRaw]);
  const applied = useLiveQuery(readApplied, []);

  const plateaus = useLiveQuery(async () => {
    const logged = await loggedExercises();
    const out: Plateau[] = [];
    for (const row of logged.slice(0, 40)) {
      if (row.count < 3) continue;
      const sessions = await exerciseSessions(row.exercise_id, 40);
      const p = detectPlateau(
        row.exercise_id,
        sessions.map((s) => ({ date: s.workout.started_at, sets: s.sets })),
      );
      if (p) out.push(p);
    }
    return out.sort((a, b) => b.weeks - a.weeks);
  }, []);

  const shown = useMemo(() => (plateaus ?? []).filter((p) => !dismissed.includes(p.exerciseId)), [plateaus, dismissed]);

  if (!plateaus || shown.length === 0) return null;

  async function dismiss(id: string) {
    await db.meta.put({ key: DISMISS_KEY, value: [...dismissed, id] });
  }

  return (
    <section className="card p-4">
      <h2 className="text-lg font-bold mb-1">Stalled lifts</h2>
      <p className="text-xs text-muted mb-3">These haven&apos;t improved for a few weeks.</p>
      <ul className="space-y-2">
        {shown.map((p) => {
          const ex = get(p.exerciseId);
          const alts = ex ? swapOptions(exercises, ex, "variety", 3) : [];
          const done = applied?.[p.exerciseId];
          return (
            <li key={p.exerciseId} className="rounded-xl bg-surface-2 p-3">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">{ex?.name ?? p.exerciseId}</p>
                  <p className="text-xs text-muted">
                    {p.weeks} weeks · best {fmtWeight(p.bestE1rm, unit)} est. 1RM · {p.sessions} sessions
                  </p>
                </div>
                <button className="text-xs text-muted shrink-0" onClick={() => dismiss(p.exerciseId)}>
                  Hide
                </button>
              </div>
              <p className="text-sm mt-2">{p.advice}</p>
              <button className="text-xs text-muted underline mt-1" onClick={() => setOpen(open === p.exerciseId ? null : p.exerciseId)}>
                {open === p.exerciseId ? "Hide variations" : "Show variations to try"}
              </button>
              {open === p.exerciseId && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {alts.map((a) => (
                    <Link key={a.id} href={`/exercises/${a.id}`} className="chip text-xs bg-surface">
                      {a.name}
                    </Link>
                  ))}
                </div>
              )}
              {done && (
                <p className="text-xs text-muted mt-2">
                  Fix applied {fmtDay(done.applied_at)}: {done.headline}
                </p>
              )}
              <PlateauFix exerciseId={p.exerciseId} unit={unit} nameOf={(id) => get(id)?.name} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recommended fix (POST /api/ai/plateau-fix)
//
// On tap, the lift's history is sent to the route, which answers with one fix:
// a new rep range, a swap to a close variation, an extra set, or a deload.
// The fix shows with Apply and Dismiss. Apply changes the user's routines that
// contain the lift (rep range, sets or the swapped exercise) or, for a deload,
// records a lighter week. Any failure (no key, offline, bad answer) only adds a
// short note: the rule-based advice above is never changed.
// ---------------------------------------------------------------------------

export const ROUTE = "/api/ai/plateau-fix";
export const APPLIED_KEY = "plateau_fix_applied";

export const MSG_UNAVAILABLE = "The recommended fix is not available right now. The advice above still applies.";
export const MSG_OFFLINE = "The recommended fix is available when back online. The advice above still applies.";
export const MSG_FAILED = "Could not get a recommended fix. The advice above still applies.";

/** Same as FIX_KINDS in lib/ai/plateau-fix.ts (checked in the test). */
export const FIX_KINDS = ["rep_range", "swap", "extra_set", "deload"] as const;
export type FixKind = (typeof FIX_KINDS)[number];

/** Same shape as Fix in lib/ai/plateau-fix.ts (checked in the test). */
export type Fix = {
  kind: FixKind;
  reason: string;
  rep_range: { min: number; max: number } | null;
  swap_exercise_id: string | null;
  extra_sets: number | null;
  deload_percent: number | null;
  deload_weight: number | null;
  duration_weeks: number;
};

/** Route limits (lib/ai/plateau-fix.ts); the body is clamped to them before sending. */
const MIN_SESSIONS = 3;
const MAX_SESSIONS = 40;
const MAX_SETS_PER_SESSION = 15;
const MAX_REPS = 100;
const MAX_WEIGHT = 1000;
const REP_MIN = 1;
const REP_MAX = 30;
const MAX_EXTRA_SETS = 2;
const DELOAD_MIN = 40;
const DELOAD_MAX = 90;
const MAX_DURATION = 6;
const MAX_REASON = 200;
/** Routine sets never go above this when an extra set is applied. */
export const MAX_ROUTINE_SETS = 10;

export type FixBodySet = { reps: number; weight: number; is_warmup?: boolean };
export type FixBody = {
  exercise_id: string;
  sessions: { date: string; sets: FixBodySet[] }[];
  equipment: Equipment[];
  goal_type: GoalType | null;
};

type HistoryIn = { started_at: string; sets: { reps: number; weight: number; is_warmup?: boolean }[] };

const pad = (n: number) => String(n).padStart(2, "0");
/** Local calendar day of an ISO timestamp as YYYY-MM-DD; null when unparseable. */
export function dateKey(iso: string): string | null {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The route body for one lift. Sessions are sorted oldest first and capped at
 * the route's limits; sets outside its ranges are dropped (warm-ups first
 * when a session has too many). Null when fewer than 3 usable sessions remain.
 */
export function buildFixBody(exerciseId: string, history: HistoryIn[], equipment: Equipment[], goalType: GoalType | null): FixBody | null {
  const sessions: FixBody["sessions"] = [];
  for (const h of history) {
    const date = dateKey(h.started_at);
    if (!date) continue;
    let sets: FixBodySet[] = h.sets
      .filter((s) => Number.isInteger(s.reps) && s.reps >= 0 && s.reps <= MAX_REPS && Number.isFinite(s.weight) && s.weight >= 0 && s.weight <= MAX_WEIGHT)
      .map((s) => {
        const weight = Math.round(s.weight * 100) / 100;
        return s.is_warmup ? { reps: s.reps, weight, is_warmup: true } : { reps: s.reps, weight };
      });
    if (sets.length > MAX_SETS_PER_SESSION) sets = sets.filter((s) => !s.is_warmup);
    sets = sets.slice(0, MAX_SETS_PER_SESSION);
    if (sets.length) sessions.push({ date, sets });
  }
  sessions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const recent = sessions.slice(-MAX_SESSIONS);
  if (recent.length < MIN_SESSIONS) return null;
  return { exercise_id: exerciseId, sessions: recent, equipment, goal_type: goalType };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** One plain line: control characters dropped, whitespace collapsed, capped. */
function plainLine(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/**
 * Checks the route's 200 body for this lift. Null when it is for another
 * lift, the kind is unknown, the kind's own field is missing or out of range,
 * or a swap names an exercise the app does not know (or the same lift).
 */
export function parseFix(json: unknown, exerciseId: string, known: (id: string) => boolean): Fix | null {
  if (!isObj(json) || json.exercise_id !== exerciseId || !isObj(json.fix)) return null;
  const f = json.fix;
  const kind = f.kind as FixKind;
  if (!FIX_KINDS.includes(kind)) return null;
  const reason = plainLine(f.reason, MAX_REASON);
  if (!reason) return null;
  if (!intIn(f.duration_weeks, 1, MAX_DURATION)) return null;
  const fix: Fix = {
    kind,
    reason,
    rep_range: null,
    swap_exercise_id: null,
    extra_sets: null,
    deload_percent: null,
    deload_weight: null,
    duration_weeks: f.duration_weeks,
  };
  switch (kind) {
    case "rep_range": {
      const r = f.rep_range;
      if (!isObj(r) || !intIn(r.min, REP_MIN, REP_MAX) || !intIn(r.max, REP_MIN, REP_MAX) || r.min > r.max) return null;
      fix.rep_range = { min: r.min, max: r.max };
      break;
    }
    case "swap": {
      const id = f.swap_exercise_id;
      if (typeof id !== "string" || id === exerciseId || !known(id)) return null;
      fix.swap_exercise_id = id;
      break;
    }
    case "extra_set":
      if (!intIn(f.extra_sets, 1, MAX_EXTRA_SETS)) return null;
      fix.extra_sets = f.extra_sets;
      break;
    case "deload": {
      if (!intIn(f.deload_percent, DELOAD_MIN, DELOAD_MAX)) return null;
      fix.deload_percent = f.deload_percent;
      const w = f.deload_weight;
      fix.deload_weight = typeof w === "number" && Number.isFinite(w) && w > 0 && w <= MAX_WEIGHT ? w : null;
      break;
    }
  }
  return fix;
}

const weeksText = (n: number) => `${n} week${n === 1 ? "" : "s"}`;
const repsText = (r: { min: number; max: number }) => (r.min === r.max ? `${r.min}` : `${r.min}-${r.max}`);

/** One-line summary of the fix, e.g. "Work in 8-12 reps for 4 weeks". */
export function describeFix(fix: Fix, nameOf: (id: string) => string | undefined, unit: Unit): string {
  const weeks = weeksText(fix.duration_weeks);
  switch (fix.kind) {
    case "rep_range":
      return `Work in ${repsText(fix.rep_range!)} reps for ${weeks}`;
    case "swap": {
      const id = fix.swap_exercise_id!;
      return `Swap to ${nameOf(id) ?? id} for ${weeks}`;
    }
    case "extra_set": {
      const n = fix.extra_sets!;
      return `Add ${n} set${n === 1 ? "" : "s"} per session for ${weeks}`;
    }
    case "deload": {
      const w = fix.deload_weight !== null ? ` (${fmtWeight(fix.deload_weight, unit)})` : "";
      return `Lighter week: about ${fix.deload_percent}%${w} of your usual weight for ${weeks}`;
    }
  }
}

/**
 * A routine's exercise list with the fix applied to `exerciseId`, or null when
 * the routine does not contain the lift or the fix does not change routines
 * (a deload). Rep range sets target_reps, an extra set raises target_sets
 * (capped), a swap replaces the exercise (keeping its sets and reps) and drops
 * a later duplicate of the new exercise.
 */
export function applyFixToRoutine(list: RoutineExerciseInput[], exerciseId: string, fix: Fix): RoutineExerciseInput[] | null {
  if (fix.kind === "deload" || !list.some((e) => e.exercise_id === exerciseId)) return null;
  const out = list.map((e) => {
    if (e.exercise_id !== exerciseId) return { ...e };
    if (fix.kind === "rep_range") return { ...e, target_reps: repsText(fix.rep_range!) };
    if (fix.kind === "extra_set") return { ...e, target_sets: Math.min(MAX_ROUTINE_SETS, (e.target_sets ?? 3) + fix.extra_sets!) };
    return { ...e, exercise_id: fix.swap_exercise_id! };
  });
  return out.filter((e, i) => out.findIndex((x) => x.exercise_id === e.exercise_id) === i);
}

export type AppliedFix = {
  kind: FixKind;
  headline: string;
  applied_at: string;
  until: string;
  /** deload only (records saved before SMALL-01 have none). */
  deload_percent?: number | null;
  deload_weight?: number | null;
};

async function readApplied(): Promise<Record<string, AppliedFix>> {
  const v = (await db.meta.get(APPLIED_KEY))?.value;
  return isObj(v) ? (v as Record<string, AppliedFix>) : {};
}

const fmtDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
};

/** The lift's history, equipment and goal from the local store, as the route body. */
export async function loadFixBody(exerciseId: string): Promise<FixBody | null> {
  const [sessions, equipment, goals] = await Promise.all([
    exerciseSessions(exerciseId, MAX_SESSIONS),
    getEquipment(),
    db.meta.get("goals"),
  ]);
  const g = isObj(goals?.value) ? goals.value.goalType : undefined;
  const goalType = typeof g === "string" && Object.hasOwn(GOAL_LABELS, g) ? (g as GoalType) : null;
  return buildFixBody(
    exerciseId,
    sessions.map((s) => ({ started_at: s.workout.started_at, sets: s.sets })),
    equipmentForAi(equipment),
    goalType,
  );
}

/**
 * Applies the fix: updates every routine that has the lift, then records it
 * (with the headline and the date it runs until). Returns routines changed.
 */
export async function applyFix(exerciseId: string, fix: Fix, headline: string, now = new Date()): Promise<number> {
  let changed = 0;
  for (const r of await listRoutines()) {
    const cur = r.exercises.map((e) => ({ exercise_id: e.exercise_id, target_sets: e.target_sets, target_reps: e.target_reps }));
    const next = applyFixToRoutine(cur, exerciseId, fix);
    if (!next) continue;
    await updateRoutine(r.id, { exercises: next });
    changed++;
  }
  const until = new Date(now.getTime() + fix.duration_weeks * 7 * 864e5).toISOString();
  await db.transaction("rw", db.meta, async () => {
    const cur = await readApplied();
    const rec: AppliedFix = { kind: fix.kind, headline, applied_at: now.toISOString(), until };
    // A lighter week also keeps its numbers, so the live workout can suggest the lighter weight (lib/lighterWeek.ts).
    if (fix.kind === "deload") {
      rec.deload_percent = fix.deload_percent;
      rec.deload_weight = fix.deload_weight;
    }
    await db.meta.put({ key: APPLIED_KEY, value: { ...cur, [exerciseId]: rec } });
  });
  return changed;
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; fix: Fix }
  | { kind: "applying"; fix: Fix }
  | { kind: "applied"; message: string };

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

export function appliedMessage(fix: Fix, routines: number, unit: Unit): string {
  if (fix.kind === "deload") {
    const w = fix.deload_weight !== null ? `about ${fmtWeight(fix.deload_weight, unit)}` : `about ${fix.deload_percent}% of your usual weight`;
    return `Lighter week started. Aim for ${w} on this lift.`;
  }
  if (routines === 0) return "Saved. None of your routines has this lift yet.";
  return `Updated ${routines} routine${routines === 1 ? "" : "s"}.`;
}

/** "Recommended fix" for one stalled lift, fetched on demand. */
export function PlateauFix({
  exerciseId,
  unit,
  nameOf,
  loadBody = loadFixBody,
  apply = applyFix,
}: {
  exerciseId: string;
  unit: Unit;
  nameOf: (id: string) => string | undefined;
  loadBody?: (exerciseId: string) => Promise<FixBody | null>;
  apply?: (exerciseId: string, fix: Fix, headline: string) => Promise<number>;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });

  const run = async () => {
    if (offline()) {
      setState({ kind: "error", message: MSG_OFFLINE });
      return;
    }
    setState({ kind: "loading" });
    try {
      const body = await loadBody(exerciseId);
      if (!body) {
        setState({ kind: "error", message: MSG_FAILED });
        return;
      }
      const res = await fetch(ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.status === 503) {
        setState({ kind: "error", message: MSG_UNAVAILABLE });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error", message: MSG_FAILED });
        return;
      }
      const fix = parseFix(await res.json(), exerciseId, (id) => nameOf(id) !== undefined);
      setState(fix ? { kind: "done", fix } : { kind: "error", message: MSG_FAILED });
    } catch {
      setState({ kind: "error", message: offline() ? MSG_OFFLINE : MSG_FAILED });
    }
  };

  const onApply = async (fix: Fix) => {
    setState({ kind: "applying", fix });
    try {
      const n = await apply(exerciseId, fix, describeFix(fix, nameOf, unit));
      setState({ kind: "applied", message: appliedMessage(fix, n, unit) });
    } catch {
      setState({ kind: "error", message: "Could not apply the fix. Nothing was changed." });
    }
  };

  if (state.kind === "done" || state.kind === "applying") {
    const { fix } = state;
    return (
      <div className="mt-2 rounded-lg bg-surface p-2.5" aria-label="Recommended fix">
        <p className="text-xs font-semibold text-muted uppercase tracking-wide">Recommended fix</p>
        <p className="text-sm font-semibold mt-1">{describeFix(fix, nameOf, unit)}</p>
        <p className="text-sm text-muted mt-0.5">{fix.reason}</p>
        <div className="flex gap-2 mt-2">
          <button type="button" className="btn-primary text-sm" disabled={state.kind === "applying"} onClick={() => onApply(fix)}>
            {state.kind === "applying" ? "Applying..." : fix.kind === "deload" ? "Start lighter week" : "Apply to routines"}
          </button>
          <button type="button" className="btn-ghost text-sm" disabled={state.kind === "applying"} onClick={() => setState({ kind: "idle" })}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2">
      {state.kind !== "applied" && (
        <button type="button" className="text-xs underline" onClick={run} disabled={state.kind === "loading"}>
          {state.kind === "loading" ? "Finding a fix..." : "Get recommended fix"}
        </button>
      )}
      {(state.kind === "error" || state.kind === "applied") && (
        <p role="status" className="text-xs text-muted mt-1">
          {state.message}
        </p>
      )}
    </div>
  );
}
