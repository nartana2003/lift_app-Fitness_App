"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useCatalogue } from "@/lib/catalogue";
import { usePreferred } from "@/lib/favorites";
import { allTargets, useGoals } from "@/lib/goals";
import { addDays, daysLeftInWeek, goalProgress, startOfWeek, type GoalProgress } from "@/lib/stats";
import { periodStats, type WorkoutLite } from "@/lib/progress";
import { useSettings } from "@/lib/settings";
import { getEquipment } from "@/lib/equipment";
import { MUSCLE_GROUPS, type MuscleGroup } from "@/lib/muscles";
import { db } from "@/lib/offline/db";
import { dayKey, getDay, planDay, weekDays } from "@/lib/planner";
import { createRoutine, getRoutine, listRoutines } from "@/lib/routines";
import { CATCH_UP_NAME, CATCH_UP_SUFFIX, historyCounts, isCatchUpRoutine, planCatchUp, sessionsThisWeek, type CatchUpPlan as CatchUpPlanData } from "@/lib/catchUp";
import { addExercises, getActive } from "@/lib/workout";

/** Done vs target sets per muscle this week, with a plan for what's behind. */
export function WeeklyGoalsCard({ workouts }: { workouts: WorkoutLite[] }) {
  const goals = useGoals();
  const [showAll, setShowAll] = useState(false);
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
  const metRows = rows.filter((r) => r.remaining <= 0);
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

      {focusFirst.length > 0 && (
        <ul className="space-y-2">
          {focusFirst.map((r) => (
            <GoalRow key={r.muscle} row={r} focus={goals.focusMuscles.includes(r.muscle as never)} />
          ))}
        </ul>
      )}
      {metRows.length > 0 && (
        <>
          <button
            type="button"
            className="mt-3 w-full flex items-center justify-between rounded-xl bg-surface-2 border border-border px-3 py-2.5 text-sm font-medium"
            aria-expanded={showAll}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? "Hide other muscles" : "Show all muscles"}
            <svg viewBox="0 0 24 24" className={`size-4 text-muted transition-transform ${showAll ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {showAll && (
            <ul className="space-y-2 mt-3">
              {metRows.map((r) => (
                <GoalRow key={r.muscle} row={r} focus={goals.focusMuscles.includes(r.muscle as never)} />
              ))}
            </ul>
          )}
        </>
      )}

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
                Sets to add on your {plan.trainingDays.length} remaining training day{plan.trainingDays.length === 1 ? "" : "s"}.
              </p>
              <CatchUpPlan key={plan.trainingDays.join()} plan={plan} nameOf={(id) => get(id)?.name ?? id} />
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
// Catch-up plan: sets to add on the training days left this week (lib/catchUp.ts),
// with a one-tap add per day.
// ---------------------------------------------------------------------------

export type GapAddition = { exercise_id: string; muscle: MuscleGroup; date: string; sets: number; reason: string };

const isMuscleName = (m: unknown): m is MuscleGroup => typeof m === "string" && (MUSCLE_GROUPS as readonly string[]).includes(m);

/** Today and the rest of this week as local YYYY-MM-DD keys. */
export function daysLeftKeys(weekStart: 0 | 1, now = new Date()): string[] {
  const today = dayKey(now);
  return weekDays(weekStart, now)
    .map(dayKey)
    .filter((k) => k >= today);
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

/**
 * The plan by training day, with a one-tap add per day (or all days). The plan is
 * frozen at the first add, so adding never reshuffles the other days.
 */
function CatchUpPlan({ plan, nameOf }: { plan: CatchUpPlanData; nameOf: (id: string) => string }) {
  const [frozen, setFrozen] = useState<CatchUpPlanData | null>(null);
  const [result, setResult] = useState<Record<string, { text: string; ok: boolean }>>({});
  const [busy, setBusy] = useState(false);

  const shown = frozen ?? plan;
  const todayKey = dayKey(new Date());
  const groups = shown.trainingDays.map((date) => ({ date, items: shown.additions.filter((a) => a.date === date) })).filter((g) => g.items.length > 0);

  async function run(date: string, items: GapAddition[]) {
    try {
      const text = await addToDay(date, items);
      setResult((r) => ({ ...r, [date]: { text, ok: true } }));
    } catch {
      setResult((r) => ({ ...r, [date]: { text: "Could not add these. Try again.", ok: false } }));
    }
  }

  async function add(dates: string[]) {
    if (!frozen) setFrozen(plan);
    setBusy(true);
    try {
      for (const date of dates) await run(date, groups.find((g) => g.date === date)!.items);
    } finally {
      setBusy(false);
    }
  }

  const todo = groups.filter((g) => !result[g.date]?.ok);

  return (
    <div>
      {groups.length > 0 ? (
        <>
          <ul className="space-y-2.5" aria-label="Catch-up plan">
            {groups.map((g, i) => {
              const wd = weekdayLabel(g.date);
              const total = g.items.reduce((n, a) => n + a.sets, 0);
              const r = result[g.date];
              return (
                <li key={g.date} aria-label={wd} className="rounded-2xl bg-surface-2 p-3">
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden="true"
                      className={`size-10 shrink-0 rounded-full bg-accent text-accent-ink grid place-items-center text-sm font-bold ${g.date === todayKey ? "ring-2 ring-accent ring-offset-2 ring-offset-surface-2" : ""}`}
                    >
                      {wd.charAt(0)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold">{wd}</p>
                      <p className="text-xs text-muted">
                        {total} set{total === 1 ? "" : "s"}
                      </p>
                    </div>
                    {r?.ok ? (
                      <span className="shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-surface border border-border px-3 py-2 text-sm font-semibold">
                        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M5 12l5 5L20 7" />
                        </svg>
                        Added
                      </span>
                    ) : (
                      <button className="btn-primary shrink-0 px-3.5 py-2 text-sm" disabled={busy} aria-label={i === 0 ? "Add to next workout" : `Add to ${wd}`} onClick={() => add([g.date])}>
                        Add
                      </button>
                    )}
                  </div>
                  <ul className="mt-2.5 space-y-1.5">
                    {g.items.map((a) => (
                      <li key={a.exercise_id} className="flex items-center gap-2.5 rounded-xl border border-border bg-surface px-2.5 py-2">
                        <span aria-hidden="true" className="size-8 shrink-0 rounded-[10px] bg-surface-2 grid place-items-center text-muted">
                          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M6 6v12M18 6v12M3 9v6M21 9v6M6 12h12" />
                          </svg>
                        </span>
                        <div className="flex-1 min-w-0">
                          <Link href={`/exercises/${a.exercise_id}`} className="block text-[13px] font-semibold leading-tight">
                            {nameOf(a.exercise_id)}
                          </Link>
                          {a.reason && <p className="text-xs text-muted leading-snug">{a.reason}</p>}
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${a.in_routine ? "bg-surface-2 border border-border" : "bg-accent text-accent-ink"}`}
                        >
                          {a.in_routine ? "+" : ""}
                          {a.sets} set{a.sets === 1 ? "" : "s"}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {r?.text && (
                    <p role="status" className="text-xs text-muted mt-2">
                      {r.text}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {groups.length > 1 && todo.length > 0 && (
            <button className="btn-primary w-full py-2.5 text-sm mt-3" disabled={busy} onClick={() => add(todo.map((g) => g.date))}>
              Add all to my week
            </button>
          )}
        </>
      ) : shown.covered.length > 0 && shown.unmet.length === 0 ? (
        <p className="text-xs text-muted">Your planned routines already cover your remaining sets.</p>
      ) : (
        <p className="text-xs text-muted">No exercises could be placed this week.</p>
      )}
      {shown.covered.length > 0 && (
        <p className="text-xs text-muted mt-3 rounded-xl bg-surface-2 px-3 py-2.5">
          <span className="font-semibold text-text">Covered by your routines:</span> {shown.covered.map((c) => `${c.muscle} (${c.sets} set${c.sets === 1 ? "" : "s"})`).join(", ")}
        </p>
      )}
      {shown.unmet.length > 0 && (
        <p className="text-xs text-muted mt-2 rounded-xl bg-surface-2 px-3 py-2.5">
          <span className="font-semibold text-text">No room this week:</span> {shown.unmet.map((u) => `${u.muscle} (${u.sets} set${u.sets === 1 ? "" : "s"})`).join(", ")}
        </p>
      )}
    </div>
  );
}
