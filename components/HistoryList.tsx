"use client";

import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { useCatalogue } from "@/lib/catalogue";
import { workoutsBetween, type WorkoutDetail } from "@/lib/history";
import { formatDuration, startOfWeek } from "@/lib/stats";
import { useSettings } from "@/lib/settings";
import { fmtVolume } from "@/lib/units";

/** Finished workouts, newest first, grouped by week. Lives on the Home screen. */
export function HistoryList() {
  const { get } = useCatalogue();
  const { unit, weekStart } = useSettings();
  const workouts = useLiveQuery(
    () => workoutsBetween(new Date(Date.now() - 400 * 864e5), new Date(Date.now() + 864e5)),
    [],
  );

  if (!workouts) return null;

  const weeks = new Map<string, WorkoutDetail[]>();
  for (const w of workouts) {
    const k = startOfWeek(new Date(w.started_at), weekStart).toISOString();
    weeks.set(k, [...(weeks.get(k) ?? []), w]);
  }

  return (
    <section className="mt-6">
      <h2 className="text-lg font-bold mb-3">My History</h2>
      {workouts.length === 0 && (
        <p className="card p-4 text-sm text-muted">No workouts yet.</p>
      )}
      {[...weeks.entries()].map(([wk, ws]) => (
        <div key={wk} className="mb-5">
          <h3 className="text-xs uppercase tracking-wide text-muted mb-2">
            Week of {new Date(wk).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · {ws.length}{" "}
            workout{ws.length > 1 ? "s" : ""}
          </h3>
          <ul className="space-y-2">
            {ws.map((w) => {
              const start = new Date(w.started_at);
              const dur = (Date.parse(w.ended_at!) - start.getTime()) / 1000;
              return (
                <li key={w.id}>
                  <Link href={`/history/${w.id}`} className="card block p-3">
                    <div className="flex justify-between gap-2">
                      <p className="font-semibold">{w.notes || start.toLocaleDateString(undefined, { weekday: "long" })}</p>
                      <p className="text-xs text-muted shrink-0">
                        {start.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ·{" "}
                        {start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </p>
                    </div>
                    <p className="text-xs text-muted mt-0.5">
                      {formatDuration(dur)} · {w.setCount} sets · {fmtVolume(w.volume, unit)}
                    </p>
                    <p className="text-sm mt-1.5 line-clamp-2 text-muted">
                      {w.exercises.map((e) => get(e.exercise_id)?.name ?? e.exercise_id).join(" · ")}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
