"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useCatalogue } from "@/lib/catalogue";
import { suggestForMuscle } from "@/lib/suggest";
import { allTargets, useGoals, type Goals } from "@/lib/goals";
import { addDays, daysLeftInWeek, goalProgress, startOfWeek, type GoalProgress } from "@/lib/stats";
import { periodStats, type WorkoutLite } from "@/lib/progress";
import { useSettings } from "@/lib/settings";
import { MUSCLE_GROUPS, type MuscleGroup } from "@/lib/muscles";
import { dayKey, getDay, planDay, weekDays } from "@/lib/planner";
import { createRoutine, getRoutine } from "@/lib/routines";
import { addExercises, getActive } from "@/lib/workout";

/** Done vs target sets per muscle this week, with suggestions for what's behind. */
export function WeeklyGoalsCard({ workouts }: { workouts: WorkoutLite[] }) {
  const goals = useGoals();
  const { weekStart } = useSettings();
  const { get, exercises } = useCatalogue();

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

      {focusFirst.length > 0 && (
        <>
          <h3 className="font-semibold mt-5 mb-1">Catch up</h3>
          <p className="text-xs text-muted mb-2">Suggestions for the muscles you&apos;re behind on.</p>
          <ul className="space-y-2">
            {focusFirst.slice(0, 3).map((r) => {
              const picks = suggestForMuscle(exercises, r.muscle, 3);
              return (
                <li key={r.muscle} className="rounded-xl bg-surface-2 p-3">
                  <p className="text-sm font-semibold">
                    {r.muscle} · {r.remaining} more set{r.remaining === 1 ? "" : "s"}
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {picks.map((e) => (
                      <Link key={e.id} href={`/exercises/${e.id}`} className="chip text-xs bg-surface">
                        {e.name}
                      </Link>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          <AiCatchUp behind={focusFirst} goals={goals} weekStart={weekStart} known={(id) => !!get(id)} nameOf={(id) => get(id)?.name ?? id} />
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
export function buildGapsRequest(behind: GoalProgress[], goals: Goals, days: string[]) {
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
    const id = await createRoutine({
      name: `${base.name} + catch up`,
      source: "ai",
      exercises: [
        ...base.exercises.map((e) => ({ exercise_id: e.exercise_id, target_sets: e.target_sets, target_reps: e.target_reps })),
        ...list.filter((e) => !have.has(e.exercise_id)),
      ],
    });
    await planDay(date, id);
    return `Added to ${base.name} on ${day}.`;
  }
  const id = await createRoutine({ name: "Catch up", source: "ai", exercises: list });
  await planDay(date, id);
  return `Planned a catch-up workout on ${day}.`;
}

type AiState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; additions: GapAddition[]; days: string[] };

export const AI_MESSAGES = {
  offline: "AI plan is available when back online.",
  unavailable: "AI plan is not available right now. The suggestions above still apply.",
  failed: "Could not get an AI plan. The suggestions above still apply.",
  empty: "No AI plan for this week. The suggestions above still apply.",
} as const;

function AiCatchUp({
  behind,
  goals,
  weekStart,
  known,
  nameOf,
}: {
  behind: GoalProgress[];
  goals: Goals;
  weekStart: 0 | 1;
  known: (id: string) => boolean;
  nameOf: (id: string) => string;
}) {
  const [state, setState] = useState<AiState>({ kind: "idle" });
  const [added, setAdded] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setState({ kind: "error", message: AI_MESSAGES.offline });
      return;
    }
    const days = daysLeftKeys(weekStart);
    const body = buildGapsRequest(behind, goals, days);
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
      const additions = parseGapsResponse(await res.json(), days, known);
      if (!additions) setState({ kind: "error", message: AI_MESSAGES.failed });
      else if (additions.length === 0) setState({ kind: "error", message: AI_MESSAGES.empty });
      else setState({ kind: "done", additions, days });
    } catch {
      setState({ kind: "error", message: AI_MESSAGES.failed });
    }
  }

  async function add(date: string, items: GapAddition[]) {
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

  const groups =
    state.kind === "done"
      ? state.days.map((date) => ({ date, items: state.additions.filter((a) => a.date === date) })).filter((g) => g.items.length > 0)
      : [];

  return (
    <div className="mt-3">
      <button className="btn-ghost w-full py-2 text-sm" onClick={load} disabled={state.kind === "loading"}>
        {state.kind === "loading" ? "Planning..." : state.kind === "done" ? "Refresh AI plan" : "Plan the week with AI"}
      </button>
      {state.kind === "error" && (
        <p role="status" className="text-xs text-muted mt-2">
          {state.message}
        </p>
      )}
      {groups.length > 0 && (
        <ul className="space-y-2 mt-2" aria-label="AI catch-up plan">
          {groups.map((g, i) => (
            <li key={g.date} className="rounded-xl bg-surface-2 p-3">
              <p className="text-sm font-semibold">{weekdayLabel(g.date)}</p>
              <ul className="mt-1 space-y-1">
                {g.items.map((a) => (
                  <li key={a.exercise_id} className="text-sm">
                    <span>
                      {nameOf(a.exercise_id)} · {a.sets} set{a.sets === 1 ? "" : "s"}
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
      )}
    </div>
  );
}
