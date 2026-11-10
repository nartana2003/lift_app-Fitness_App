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
 * The plan by training day, with a one-tap add per day. The plan is frozen at the
 * first add, so tapping add never reshuffles the other days.
 */
function CatchUpPlan({ plan, nameOf }: { plan: CatchUpPlanData; nameOf: (id: string) => string }) {
  const [frozen, setFrozen] = useState<CatchUpPlanData | null>(null);
  const [added, setAdded] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const shown = frozen ?? plan;

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

  const groups = shown.trainingDays.map((date) => ({ date, items: shown.additions.filter((a) => a.date === date) })).filter((g) => g.items.length > 0);

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
      {shown.unmet.length > 0 && (
        <p className="text-xs text-muted mt-2">
          Not enough room this week for: {shown.unmet.map((u) => `${u.muscle} (${u.sets} set${u.sets === 1 ? "" : "s"})`).join(", ")}.
        </p>
      )}
    </div>
  );
}
