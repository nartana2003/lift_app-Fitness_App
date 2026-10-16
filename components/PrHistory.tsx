"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { exerciseSessions } from "@/lib/history";
import { e1rm } from "@/lib/prs";
import { useSettings } from "@/lib/settings";
import { fmtWeight, fmtVolume } from "@/lib/units";

type Record = { label: string; value: string; when: string; detail?: string };

/** Your records for one exercise: heaviest, best reps, best estimated 1RM, best session volume. */
export function PrHistory({ exerciseId }: { exerciseId: string }) {
  const { unit } = useSettings();
  const sessions = useLiveQuery(() => exerciseSessions(exerciseId, 500), [exerciseId]);
  if (!sessions || sessions.length === 0) return null;

  const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

  let heaviest = { weight: 0, reps: 0, when: "" };
  let mostReps = { weight: 0, reps: 0, when: "" };
  let best1rm = { value: 0, weight: 0, reps: 0, when: "" };
  let bestVolume = { value: 0, when: "" };

  for (const s of sessions) {
    let volume = 0;
    for (const set of s.sets) {
      if (set.is_warmup || set.reps <= 0) continue;
      volume += set.reps * set.weight;
      if (set.weight > heaviest.weight) heaviest = { weight: set.weight, reps: set.reps, when: s.workout.started_at };
      if (set.reps > mostReps.reps) mostReps = { weight: set.weight, reps: set.reps, when: s.workout.started_at };
      const est = e1rm(set.weight, set.reps);
      if (est > best1rm.value) best1rm = { value: est, weight: set.weight, reps: set.reps, when: s.workout.started_at };
    }
    if (volume > bestVolume.value) bestVolume = { value: volume, when: s.workout.started_at };
  }

  const records: Record[] = [];
  if (heaviest.weight > 0)
    records.push({ label: "Heaviest weight", value: fmtWeight(heaviest.weight, unit), detail: `× ${heaviest.reps} reps`, when: heaviest.when });
  if (mostReps.reps > 0)
    records.push({ label: "Most reps", value: `${mostReps.reps} reps`, detail: `at ${fmtWeight(mostReps.weight, unit)}`, when: mostReps.when });
  if (best1rm.value > 0)
    records.push({ label: "Best est. 1RM", value: fmtWeight(best1rm.value, unit), detail: `from ${mostRepsLabel(best1rm, unit)}`, when: best1rm.when });
  if (bestVolume.value > 0)
    records.push({ label: "Best session volume", value: fmtVolume(bestVolume.value, unit), when: bestVolume.when });

  if (records.length === 0) return null;

  return (
    <section className="card p-4 mt-4">
      <h2 className="font-semibold mb-2">Records</h2>
      <ul className="divide-y divide-border">
        {records.map((r) => (
          <li key={r.label} className="flex items-baseline gap-3 py-2">
            <span className="flex-1 text-sm text-muted">{r.label}</span>
            <span className="text-right">
              <span className="block font-semibold">{r.value}</span>
              <span className="block text-[11px] text-muted">
                {r.detail ? `${r.detail} · ` : ""}
                {date(r.when)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const mostRepsLabel = (r: { weight: number; reps: number }, unit: "kg" | "lb") => `${fmtWeight(r.weight, unit)} × ${r.reps}`;
