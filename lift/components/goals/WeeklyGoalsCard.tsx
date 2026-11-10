"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useCatalogue } from "@/lib/catalogue";
import { usePreferred } from "@/lib/favorites";
import { allTargets, useGoals, type Goals } from "@/lib/goals";
import { addDays, daysLeftInWeek, goalProgress, startOfWeek, type GoalProgress } from "@/lib/stats";
import { periodStats, type WorkoutLite } from "@/lib/progress";
import { useSettings } from "@/lib/settings";
import { equipmentForAi, getEquipment } from "@/lib/equipment";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "@/lib/muscles";
import { db } from "@/lib/offline/db";
import { dayKey, getDay, planDay, weekDays } from "@/lib/planner";
import { createRoutine, getRoutine, listRoutines } from "@/lib/routines";
import { CATCH_UP_NAME, CATCH_UP_SUFFIX, historyCounts, isCatchUpRoutine, planCatchUp, sessionsThisWeek, type CatchUpPlan as CatchUpPlanData } from "@/lib/catchUp";
import { addExercises, getActive } from "@/lib/workout";

/** Done vs target sets per muscle this week, with a plan for what's behind. */
export function WeeklyGoalsCard({ workouts }: { workouts: WorkoutLite[] }) {
  const goals = useGoals();
  const { weekStart } = useSettings();
  const { get, exercises } = useCatalogue();
  // Each of these is undefined until it has loaded; the plan waits so it never shows a first guess that then changes.
  const preferred = usePreferred();
  const equipment = useLiveQuery(getEquipment, []);
  const routines = useLiveQuery(() => listRoutines(), []);
  const from = dayKey(startOfWeek(new Date(), weekStart));
  const planned = useLiveQuery(() => db.planned_days.where("date").between(from, dayKey(addDays(new Date(from + "T00:00:00"), 6)), true, true).toArray(), [from]);
  const ready = !!preferred && !!equipment && !!routines && !!planned;

  const rows = useMemo(() => {
    const from = startOfWeek(new Date(), weekStart);
    const stats = periodStats(workouts, from, addDays(from, 7), (id) => get(id)?.muscle_groups ?? []);
    return goalProgress(stats.sets_by_muscle, allTargets(goals));
  }, [workouts, goals, weekStart, get]);

  const daysLeft = daysLeftInWeek(new Date(), weekStart);
  const met = rows.filter((r) => r.status === "met").length;
  const behind = rows.filter((r) => r.remaining > 0);
  const focusFirst = [...behind].sort((a, b) => {
    const fa = goals.focusMuscles.includes(a.muscle as never) ? 0 : 1;
    const fb = goals.focusMuscles.includes(b.muscle as never) ? 0 : 1;
    return fa - fb || b.remaining - a.remaining;
  });

  const days = daysLeftKeys(weekStart);
  const sessionsDone = sessionsThisWeek(workouts, weekStart);
  const plan = planCatchUp({
    behind: focusFirst.filter((r) => isMuscleName(r.muscle)).map((r) => ({ muscle: r.muscle as MuscleGroup, remaining: r.remaining })),
    days,
    planned: planned ?? [],
    sessionsPerWeek: goals.sessionsPerWeek,
    sessionsDone,
    routines: new Map((routines ?? []).map((r) => [r.id, r])),
    catalogue: exercises,
    history: historyCounts(workouts),
    favorites: preferred ?? [],
    dislikedIds: goals.dislikedIds,
    equipment: equipment ?? [],
  });

  return (
    <section className="card p-4">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <h2 className="text-lg font-bold">Weekly goals</h2>
          <p className="text-xs text-muted">
            {met} of {rows.length} muscles met · {daysLeft} day{daysLeft === 1 ? "" : "s"} left this week
          </p>
        </div>
        <Link href="/profile" className="text-xs text-muted underline shrink-0 pt-1">
          Edit goals
        </Link>
      </div>

      <ul className="space-y-2">
        {rows.map((r) => (
          <GoalRow key={r.muscle} row={r} focus={goals.focusMuscles.includes(r.muscle as never)} />
        ))}
      </ul>

      {focusFirst.length === 0 && <p className="text-xs text-muted mt-4">All weekly targets are met.</p>}
      {focusFirst.length > 0 && (
        <>
          <h3 className="font-semibold mt-5 mb-1">Catch up</h3>
          {!ready ? null : plan.noSessionsLeft ? (
            <p className="text-xs text-muted">
              You have done your {goals.sessionsPerWeek} session{goals.sessionsPerWeek === 1 ? "" : "s"} this week, so no more are added.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted mb-2">
                Sets to add on your {plan.trainingDays.length} remaining training day{plan.trainingDays.length === 1 ? "" : "s"}, based on your routines.
              </p>
              <CatchUpPlan
                key={plan.trainingDays.join()}
                plan={plan}
                behind={focusFirst}
                goals={goals}
                favorites={preferred!}
                equipment={equipment!}
                known={(id) => !!get(id)}
                nameOf={(id) => get(id)?.name ?? id}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}

function GoalRow({ row, focus }: { row: GoalProgress; focus: boolean }) {
  const pct = Math.min(100, (row.done / Math.max(1, row.target)) * 100);
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className="w-28 shrink-0 truncate">
        {row.muscle}
        {focus && <span className="text-muted"> ★</span>}
      </span>
      <span className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
        <span
          className={`block h-full rounded-full ${row.status === "met" ? "bg-accent" : "bg-muted"}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-14 text-right text-xs text-muted tabular-nums">
        {row.done}/{row.target}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// AI catch-up plan (POST /api/ai/goal-gaps). The rule-based chips above stay
// as they are; this only adds a plan with a day for each exercise and a
// one-tap add. Any failure leaves the card exactly as it was, plus a short note.
// ---------------------------------------------------------------------------

/** Mirrors the route's limits (MAX_TARGET and MAX_USER_TARGET in lib/ai/goal-targets.ts, MAX_SETS_PER_ADD in lib/ai/goal-gaps.ts). */
export const GAP_MAX_REMAINING = 24;
export const GAP_MAX_TARGET = 40;
const GAP_MAX_FAVORITES = 200;
export const GAP_MAX_SETS = 6;

export type GapAddition = { exercise_id: string; muscle: MuscleGroup; date: string; sets: number; reason: string };

const isMuscleName = (m: unknown): m is MuscleGroup => typeof m === "string" && (MUSCLE_GROUPS as readonly string[]).includes(m);
const intIn = (n: unknown, lo: number, hi: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;

/** Today and the rest of this week as local YYYY-MM-DD keys. */
export function daysLeftKeys(weekStart: 0 | 1, now = new Date()): string[] {
  const today = dayKey(now);
  return weekDays(weekStart, now)
    .map(dayKey)
    .filter((k) => k >= today);
}

/** The request body the goal-gaps route accepts, built from the card's rows. Null when nothing is behind. */
export function buildGapsRequest(behind: GoalProgress[], goals: Goals, days: string[], favorites: string[] = [], equipment: Equipment[] = []) {
  const gaps = behind
    .filter((r) => isMuscleName(r.muscle) && r.remaining > 0)
    .map((r) => {
      const sets_remaining = Math.min(r.remaining, GAP_MAX_REMAINING);
      return {
        muscle: r.muscle as MuscleGroup,
        sets_remaining,
        ...(intIn(r.target, sets_remaining, GAP_MAX_TARGET) ? { target: r.target } : {}),
      };
    });
  if (gaps.length === 0 || days.length === 0) return null;
  const targets: Partial<Record<MuscleGroup, number>> = {};
  for (const [m, v] of Object.entries(goals.targets ?? {})) if (isMuscleName(m) && intIn(v, 0, GAP_MAX_TARGET)) targets[m] = v;
  return {
    gaps,
    days_left: days,
    goals: {
      goalType: goals.goalType,
      experience: goals.experience,
      sessionsPerWeek: Math.max(1, Math.min(7, Math.round(goals.sessionsPerWeek || 3))),
      focusMuscles: goals.focusMuscles.filter(isMuscleName),
      targets,
    },
    ...(favorites.length ? { favorites: favorites.slice(0, GAP_MAX_FAVORITES) } : {}),
    ...(equipmentForAi(equipment).length ? { equipment: equipmentForAi(equipment) } : {}),
  };
}

/** Keeps only well-formed additions for known exercises on the days offered. Null when the body is unusable. */
export function parseGapsResponse(json: unknown, days: string[], known: (id: string) => boolean): GapAddition[] | null {
  if (typeof json !== "object" || json === null || !Array.isArray((json as { additions?: unknown }).additions)) return null;
  const out: GapAddition[] = [];
  for (const a of (json as { additions: unknown[] }).additions) {
    if (typeof a !== "object" || a === null) continue;
    const { exercise_id, muscle, date, sets, reason } = a as Record<string, unknown>;
    if (typeof exercise_id !== "string" || !known(exercise_id)) continue;
    if (!isMuscleName(muscle) || typeof date !== "string" || !days.includes(date) || !intIn(sets, 1, GAP_MAX_SETS)) continue;
    if (out.some((x) => x.date === date && x.exercise_id === exercise_id)) continue;
    out.push({ exercise_id, muscle, date, sets, reason: typeof reason === "string" ? reason.slice(0, 200) : "" });
  }
  return out;
}

const weekdayLabel = (key: string) => new Date(key + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });

/**
 * Puts one day's additions into a workout, local-first:
 * - today with a workout in progress: appended to it (exercises already in it are skipped);
 * - a day with a planned routine: a copy of that routine plus the additions is
 *   planned on that day instead, so the saved routine itself is never changed;
 * - a free day: a new "Catch up" routine is created and planned on it.
 * Days already done, skipped or moved are left alone.
 */
export async function addToDay(date: string, additions: GapAddition[], now = new Date()): Promise<string> {
  const items = additions.filter((a) => a.date === date);
  if (items.length === 0) return "Nothing to add.";
  const day = weekdayLabel(date);

  if (date === dayKey(now)) {
    const active = await getActive();
    if (active) {
      const have = new Set(active.exercises.map((e) => e.exercise_id));
      const ids = items.map((a) => a.exercise_id).filter((id) => !have.has(id));
      if (ids.length) await addExercises(ids);
      return "Added to your current workout.";
    }
  }

  const planned = await getDay(date);
  if (planned && planned.status !== "planned") return `${day} already has a finished or skipped workout.`;
  const list = items.map((a) => ({ exercise_id: a.exercise_id, target_sets: a.sets }));
  const base = planned?.routine_id ? await getRoutine(planned.routine_id) : undefined;
  if (base) {
    const have = new Set(base.exercises.map((e) => e.exercise_id));
    const more = new Map(list.map((e) => [e.exercise_id, e.target_sets]));
    const id = await createRoutine({
      name: isCatchUpRoutine(base.name) ? base.name : `${base.name}${CATCH_UP_SUFFIX}`,
      source: "ai",
      favorite: false,
      exercises: [
        // An exercise already in the routine gets the extra sets; the rest are added.
        ...base.exercises.map((e) => ({ exercise_id: e.exercise_id, target_sets: e.target_sets + (more.get(e.exercise_id) ?? 0), target_reps: e.target_reps })),
        ...list.filter((e) => !have.has(e.exercise_id)),
      ],
    });
    await planDay(date, id);
    return `Added to ${base.name} on ${day}.`;
  }
  const id = await createRoutine({ name: CATCH_UP_NAME, source: "ai", favorite: false, exercises: list });
  await planDay(date, id);
  return `Planned a catch-up workout on ${day}.`;
}

type AiState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; additions: GapAddition[] };

export const AI_MESSAGES = {
  offline: "AI refine is available when back online.",
  unavailable: "AI refine is not available right now. The plan above still applies.",
  failed: "Could not refine the plan with AI. The plan above still applies.",
  empty: "AI had no changes for this week. The plan above still applies.",
} as const;

/**
 * The rule-based plan by training day, with a one-tap add per day. "Refine with AI"
 * swaps in the AI's picks for the same days; any failure leaves the plan as it was.
 * The plan is frozen at the first add, so tapping add never reshuffles the other days.
 */
function CatchUpPlan({
  plan,
  behind,
  goals,
  favorites,
  equipment,
  known,
  nameOf,
}: {
  plan: CatchUpPlanData;
  behind: GoalProgress[];
  goals: Goals;
  favorites: string[];
  equipment: Equipment[];
  known: (id: string) => boolean;
  nameOf: (id: string) => string;
}) {
  const [state, setState] = useState<AiState>({ kind: "idle" });
  const [frozen, setFrozen] = useState<CatchUpPlanData | null>(null);
  const [added, setAdded] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const shown = frozen ?? plan;
  const additions: GapAddition[] = state.kind === "done" ? state.additions : shown.additions;

  async function refine() {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setState({ kind: "error", message: AI_MESSAGES.offline });
      return;
    }
    const days = shown.trainingDays;
    // Sets your planned routines already cover are not asked for again.
    const covered = new Map<string, number>(shown.covered.map((c) => [c.muscle, c.sets]));
    const gaps = behind.map((r) => ({ ...r, remaining: r.remaining - (covered.get(r.muscle) ?? 0) })).filter((r) => r.remaining > 0);
    const body = buildGapsRequest(gaps, goals, days, favorites, equipment);
    if (!body) return;
    setState({ kind: "loading" });
    setAdded({});
    try {
      const res = await fetch("/api/ai/goal-gaps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setState({ kind: "error", message: res.status === 503 ? AI_MESSAGES.unavailable : AI_MESSAGES.failed });
        return;
      }
      const picks = parseGapsResponse(await res.json(), days, known);
      if (!picks) setState({ kind: "error", message: AI_MESSAGES.failed });
      else if (picks.length === 0) setState({ kind: "error", message: AI_MESSAGES.empty });
      else setState({ kind: "done", additions: picks });
    } catch {
      setState({ kind: "error", message: AI_MESSAGES.failed });
    }
  }

  async function add(date: string, items: GapAddition[]) {
    if (!frozen) setFrozen(plan);
    setBusy(date);
    try {
      const msg = await addToDay(date, items);
      setAdded((a) => ({ ...a, [date]: msg }));
    } catch {
      setAdded((a) => ({ ...a, [date]: "Could not add these. Try again." }));
    } finally {
      setBusy(null);
    }
  }

  const groups = shown.trainingDays.map((date) => ({ date, items: additions.filter((a) => a.date === date) })).filter((g) => g.items.length > 0);

  return (
    <div>
      {groups.length > 0 ? (
        <ul className="space-y-2" aria-label="Catch-up plan">
          {groups.map((g, i) => (
            <li key={g.date} className="rounded-xl bg-surface-2 p-3">
              <p className="text-sm font-semibold">{weekdayLabel(g.date)}</p>
              <ul className="mt-1 space-y-1">
                {g.items.map((a) => (
                  <li key={a.exercise_id} className="text-sm">
                    <Link href={`/exercises/${a.exercise_id}`} className="underline">
                      {nameOf(a.exercise_id)}
                    </Link>
                    <span>
                      {" "}
                      · {a.sets} set{a.sets === 1 ? "" : "s"}
                    </span>
                    {a.reason && <span className="block text-xs text-muted">{a.reason}</span>}
                  </li>
                ))}
              </ul>
              {added[g.date] ? (
                <p role="status" className="text-xs text-muted mt-2">
                  {added[g.date]}
                </p>
              ) : (
                <button className="btn-primary w-full py-2 text-sm mt-2" disabled={busy !== null} onClick={() => add(g.date, g.items)}>
                  {i === 0 ? "Add to next workout" : `Add to ${weekdayLabel(g.date)}`}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : shown.covered.length > 0 && shown.unmet.length === 0 ? (
        <p className="text-xs text-muted">Your planned routines already cover your remaining sets.</p>
      ) : (
        <p className="text-xs text-muted">No exercises could be placed this week.</p>
      )}
      {shown.covered.length > 0 && (
        <p className="text-xs text-muted mt-2">
          Already covered by your planned routines: {shown.covered.map((c) => `${c.muscle} (${c.sets} set${c.sets === 1 ? "" : "s"})`).join(", ")}.
        </p>
      )}
      {state.kind !== "done" && shown.unmet.length > 0 && (
        <p className="text-xs text-muted mt-2">
          Not enough room this week for: {shown.unmet.map((u) => `${u.muscle} (${u.sets} set${u.sets === 1 ? "" : "s"})`).join(", ")}.
        </p>
      )}
      {state.kind === "error" && (
        <p role="status" className="text-xs text-muted mt-2">
          {state.message}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button className="btn-ghost flex-1 py-2 text-sm" onClick={refine} disabled={state.kind === "loading" || groups.length === 0}>
          {state.kind === "loading" ? "Refining..." : state.kind === "done" ? "Refresh AI plan" : "Refine with AI"}
        </button>
        {state.kind === "done" && (
          <button className="btn-ghost py-2 px-3 text-sm" onClick={() => (setState({ kind: "idle" }), setAdded({}))}>
            Basic plan
          </button>
        )}
      </div>
    </div>
  );
}
