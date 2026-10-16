"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ExerciseDemo } from "@/components/ExerciseDemo";
import { useCatalogue } from "@/lib/catalogue";
import { exerciseSessions, loggedExercises } from "@/lib/history";
import { exerciseSeries, filterByRange, RANGES, type ExerciseMetric, type RangeKey } from "@/lib/progress";
import { useSettings } from "@/lib/settings";
import { dispNum } from "@/lib/units";
import { Segmented } from "./Segmented";

const METRICS: { value: ExerciseMetric; label: string }[] = [
  { value: "e1rm", label: "Est. Strength" },
  { value: "weight", label: "Weight" },
  { value: "volume", label: "Volume" },
  { value: "reps", label: "Reps" },
];

export function ExercisesTab() {
  const { get } = useCatalogue();
  const logged = useLiveQuery(() => loggedExercises(), []);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const rows = useMemo(
    () => (logged ?? []).filter((r) => !q.trim() || (get(r.exercise_id)?.name ?? "").toLowerCase().includes(q.trim().toLowerCase())),
    [logged, q, get],
  );

  if (!logged) return null;
  if (logged.length === 0) {
    return <p className="card p-4 text-sm text-muted">Exercises you log will appear here with a progress chart for each.</p>;
  }

  return (
    <>
      <input className="field rounded-full mb-3" placeholder="Search your exercises" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="space-y-2">
        {rows.map((r) => {
          const ex = get(r.exercise_id);
          return (
            <li key={r.exercise_id}>
              <button className="card w-full flex items-center gap-3 p-2.5 text-left" onClick={() => setOpen(r.exercise_id)}>
                <ExerciseDemo urls={ex?.image_urls.slice(0, 1) ?? []} alt={ex?.name ?? ""} small />
                <span className="flex-1 min-w-0">
                  <span className="block font-semibold truncate">{ex?.name ?? r.exercise_id}</span>
                  <span className="block text-xs text-muted truncate">
                    {ex?.muscle_groups.join(", ")} · {r.count} session{r.count === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="chip text-xs font-semibold">View Progress</span>
              </button>
            </li>
          );
        })}
      </ul>
      {open && <ExerciseProgressModal exerciseId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ExerciseProgressModal({ exerciseId, onClose }: { exerciseId: string; onClose: () => void }) {
  const { get } = useCatalogue();
  const { unit } = useSettings();
  const ex = get(exerciseId);
  const [metric, setMetric] = useState<ExerciseMetric>("e1rm");
  const [range, setRange] = useState<RangeKey>("3m");
  const sessions = useLiveQuery(() => exerciseSessions(exerciseId, 1000), [exerciseId]);

  const data = useMemo(() => {
    if (!sessions) return [];
    const pts = filterByRange(exerciseSeries(sessions, metric), range);
    const conv = (v: number) => (metric === "reps" ? v : dispNum(v, unit));
    return pts.map((p) => ({ date: p.date, label: new Date(p.date).toLocaleDateString(undefined, { day: "numeric", month: "short" }), value: conv(p.value) }));
  }, [sessions, metric, range, unit]);

  const suffix = metric === "reps" ? "" : ` ${unit}`;
  const best = data.length ? Math.max(...data.map((d) => d.value)) : 0;
  const first = data[0]?.value ?? 0;
  const last = data.at(-1)?.value ?? 0;

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="card w-full max-w-lg max-h-[92dvh] overflow-y-auto rounded-b-none sm:rounded-b-2xl p-4 pb-safe" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-3">
          <h2 className="flex-1 text-lg font-bold leading-tight">{ex?.name ?? exerciseId} — Progress</h2>
          <button className="size-9 rounded-full bg-surface-2 text-lg" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="flex items-center gap-3 mb-3">
          <ExerciseDemo urls={ex?.image_urls.slice(0, 1) ?? []} alt={ex?.name ?? ""} small />
          <p className="text-sm text-muted">{ex?.muscle_groups.join(", ")}</p>
        </div>

        <div className="overflow-x-auto no-scrollbar -mx-1 px-1 mb-2">
          <Segmented value={metric} onChange={setMetric} options={METRICS} />
        </div>
        <select className="field w-auto py-1.5 text-sm mb-2" value={range} onChange={(e) => setRange(e.target.value as RangeKey)}>
          {RANGES.map((r) => (
            <option key={r.key} value={r.key}>{r.label}</option>
          ))}
        </select>

        {data.length === 0 ? (
          <p className="text-sm text-muted py-10 text-center">No sessions in this range.</p>
        ) : (
          <>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} minTickGap={24} />
                  <YAxis width={40} tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} domain={["auto", "auto"]} />
                  <Tooltip formatter={(v) => [`${v}${suffix}`, METRICS.find((m) => m.value === metric)?.label]} contentStyle={{ borderRadius: 12, border: "1px solid #e5e7eb", fontSize: 12 }} />
                  <Line type="monotone" dataKey="value" stroke="#111111" strokeWidth={2} dot={{ r: 3, fill: "#111111" }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center mt-2">
              <Stat label="Latest" value={`${last}${suffix}`} />
              <Stat label="Best" value={`${best}${suffix}`} />
              <Stat label="Change" value={`${last - first >= 0 ? "+" : ""}${Math.round((last - first) * 10) / 10}${suffix}`} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-2 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className="font-semibold text-sm">{value}</p>
    </div>
  );
}

