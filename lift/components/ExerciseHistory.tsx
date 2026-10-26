"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { exerciseSessions } from "@/lib/history";
import { bestsFromHistory, e1rm } from "@/lib/prs";
import { formatSets } from "@/lib/overload";
import { useSettings } from "@/lib/settings";
import { dispNum, fmtWeight } from "@/lib/units";

export function ExerciseHistory({ exerciseId }: { exerciseId: string }) {
  const { unit } = useSettings();
  const sessions = useLiveQuery(() => exerciseSessions(exerciseId, 200), [exerciseId]);
  if (!sessions) return null;
  if (sessions.length === 0) {
    return <p className="card p-4 mt-4 text-sm text-muted">You haven&apos;t logged this exercise yet.</p>;
  }

  const last = sessions[0];
  const bests = bestsFromHistory(sessions.map((s) => s.sets));
  const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

  return (
    <section className="card p-4 mt-4 space-y-3">
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Last time" value={formatSets(last.sets, unit)} sub={date(last.workout.started_at)} />
        <Stat label="Heaviest" value={fmtWeight(bests.weight, unit)} />
        <Stat label="Est. 1RM" value={fmtWeight(bests.e1rm, unit)} />
      </div>
      <details>
        <summary className="text-sm text-muted">History ({sessions.length} sessions)</summary>
        <ul className="mt-2 space-y-1 text-sm">
          {sessions.slice(0, 20).map((s) => (
            <li key={s.workout.id} className="flex justify-between gap-2">
              <span className="text-muted">{date(s.workout.started_at)}</span>
              <span className="truncate">
                {s.sets.filter((x) => !x.is_warmup).map((x) => `${x.reps}×${dispNum(x.weight, unit)}`).join(", ")}
              </span>
              <span className="text-muted">
                {dispNum(Math.max(...s.sets.map((x) => e1rm(x.weight, x.reps))), unit)}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className="font-semibold">{value || "—"}</p>
      {sub && <p className="text-[11px] text-muted">{sub}</p>}
    </div>
  );
}
