"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { exerciseSessions } from "@/lib/history";
import { useSettings } from "@/lib/settings";
import { fmtWeight } from "@/lib/units";

type Record = { label: string; value: string; when: string; detail?: string };

/** Your records for one exercise: heaviest set and most reps. */
export function PrHistory({ exerciseId }: { exerciseId: string }) {
  const { unit } = useSettings();
  const sessions = useLiveQuery(() => exerciseSessions(exerciseId, 500), [exerciseId]);
  if (!sessions || sessions.length === 0) return null;

  // The year is only shown for an older record.
  const date = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  };

  let heaviest = { weight: 0, reps: 0, when: "" };
  let mostReps = { weight: 0, reps: 0, when: "" };

  for (const s of sessions) {
    for (const set of s.sets) {
      if (set.is_warmup || set.reps <= 0) continue;
      if (set.weight > heaviest.weight) heaviest = { weight: set.weight, reps: set.reps, when: s.workout.started_at };
      if (set.reps > mostReps.reps) mostReps = { weight: set.weight, reps: set.reps, when: s.workout.started_at };
    }
  }

  const records: Record[] = [];
  if (heaviest.weight > 0)
    records.push({ label: "Heaviest", value: fmtWeight(heaviest.weight, unit), detail: `${heaviest.reps} reps`, when: heaviest.when });
  if (mostReps.reps > 0)
    records.push({ label: "Most reps", value: `${mostReps.reps} reps`, detail: `at ${fmtWeight(mostReps.weight, unit)}`, when: mostReps.when });

  if (records.length === 0) return null;

  return (
    <section className="card p-4 mt-4">
      <h2 className="font-semibold">Records</h2>
      <ul className="grid grid-cols-2 gap-2 mt-2.5">
        {records.map((r) => (
          <li key={r.label} className="rounded-xl bg-surface-2 p-2.5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0zM17 5h3v2a3 3 0 01-3 3M7 5H4v2a3 3 0 003 3" />
              </svg>
              {r.label}
            </p>
            <p className="text-lg font-bold mt-1 tabular-nums">{r.value}</p>
            <p className="text-[11px] text-muted">
              {r.detail ? `${r.detail} · ` : ""}
              {date(r.when)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
