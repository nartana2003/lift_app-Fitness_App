"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useCatalogue } from "@/lib/catalogue";
import { suggestForMuscle } from "@/lib/suggest";
import { allTargets, useGoals } from "@/lib/goals";
import { addDays, daysLeftInWeek, goalProgress, startOfWeek, type GoalProgress } from "@/lib/stats";
import { periodStats, type WorkoutLite } from "@/lib/progress";
import { useSettings } from "@/lib/settings";

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
