"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { exerciseSessions } from "@/lib/history";
import { exerciseSeries } from "@/lib/progress";
import { useSettings } from "@/lib/settings";
import { dispNum } from "@/lib/units";

const dayMonth = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** A trend of the heaviest set once there are two or more sessions. Last time is shown in the workout, not here. */
export function ExerciseHistory({ exerciseId }: { exerciseId: string }) {
  const { unit } = useSettings();
  const sessions = useLiveQuery(() => exerciseSessions(exerciseId, 200), [exerciseId]);
  if (!sessions) return null;
  if (sessions.length === 0) {
    return <p className="card p-4 mt-4 text-sm text-muted">You haven&apos;t logged this exercise yet.</p>;
  }

  const data = exerciseSeries(sessions, "weight").map((p) => ({ label: dayMonth(p.date), value: dispNum(p.value, unit) }));

  return (
    <section className="card p-4 mt-4">
        <h2 className="font-semibold">Progress</h2>
        <p className="text-xs text-muted">Heaviest set over time</p>
        {data.length < 2 ? (
          <p className="mt-2.5 rounded-xl bg-surface-2 px-3 py-2.5 text-xs text-muted">Log one more session to see your trend.</p>
        ) : (
          <div className="h-36 mt-2" role="img" aria-label={`Heaviest set went from ${data[0].value} to ${data[data.length - 1].value} ${unit}`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} minTickGap={24} />
                <YAxis width={40} tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} domain={["auto", "auto"]} />
                <Tooltip formatter={(v) => [`${v} ${unit}`, "Heaviest set"]} contentStyle={{ borderRadius: 12, border: "1px solid #e5e7eb", fontSize: 12 }} />
                <Line type="monotone" dataKey="value" stroke="#111111" strokeWidth={2} dot={{ r: 3, fill: "#111111" }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
    </section>
  );
}

/** Every logged session for the exercise, collapsed until opened. */
export function SessionLog({ exerciseId }: { exerciseId: string }) {
  const { unit } = useSettings();
  const sessions = useLiveQuery(() => exerciseSessions(exerciseId, 200), [exerciseId]);
  if (!sessions || sessions.length === 0) return null;

  return (
    <section className="card p-4 mt-4">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between [&::-webkit-details-marker]:hidden">
          <span>
            <span className="block font-semibold">History</span>
            <span className="block text-xs text-muted">
              {sessions.length} session{sessions.length === 1 ? "" : "s"}
            </span>
          </span>
          <svg viewBox="0 0 24 24" className="size-[18px] text-muted transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </summary>
        <ul className="mt-3 space-y-1.5 text-sm">
          {sessions.slice(0, 20).map((s) => (
            <li key={s.workout.id} className="flex justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2">
              <span className="text-muted">{dayMonth(s.workout.started_at)}</span>
              <span className="truncate">
                {s.sets.filter((x) => !x.is_warmup).map((x) => `${x.reps}×${dispNum(x.weight, unit)}`).join(", ")}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
