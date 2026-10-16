"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { RANGES, weeklyBuckets, weeksForRange, type Metric, type RangeKey, type WorkoutLite } from "@/lib/progress";
import { dispNum, type Unit } from "@/lib/units";
import { Segmented } from "./Segmented";

const INK = "#111111";

const kfmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : String(Math.round(v)));
const minfmt = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${Math.round(m % 60) ? ` ${Math.round(m % 60)}m` : ""}` : `${Math.round(m)}m`);

/** Weekly bars for Volume / Workouts / Duration with a range picker. */
export function VolumeChart({ workouts, unit, weekStart }: { workouts: WorkoutLite[]; unit: Unit; weekStart: 0 | 1 }) {
  const [metric, setMetric] = useState<Metric>("volume");
  const [range, setRange] = useState<RangeKey>("3m");

  const data = useMemo(() => {
    const weeks = weeksForRange(range, workouts, weekStart);
    return weeklyBuckets(workouts, weeks, metric, weekStart).map((b) => ({
      label: b.label,
      value: metric === "volume" ? dispNum(b.value, unit) : Math.round(b.value),
    }));
  }, [workouts, metric, range, unit, weekStart]);

  const ticks = data.length ? [data[0].label, data[Math.floor(data.length / 2)].label, data[data.length - 1].label] : [];
  const fmt = (v: number) => (metric === "volume" ? `${kfmt(v)} ${unit}` : metric === "duration" ? minfmt(v) : String(v));
  const empty = data.every((d) => d.value === 0);

  return (
    <section className="card p-3">
      <div className="flex items-center justify-between gap-2 mb-3">
        <Segmented
          value={metric}
          onChange={setMetric}
          options={[
            { value: "volume", label: "Volume" },
            { value: "workouts", label: "Workouts" },
            { value: "duration", label: "Duration" },
          ]}
        />
        <select className="field w-auto py-1.5 text-sm" value={range} onChange={(e) => setRange(e.target.value as RangeKey)}>
          {RANGES.map((r) => (
            <option key={r.key} value={r.key}>{r.label}</option>
          ))}
        </select>
      </div>
      <div className="h-52 relative">
        {empty && (
          <p className="absolute inset-0 grid place-items-center text-sm text-muted z-10 pointer-events-none">
            Finish a workout to see your trend
          </p>
        )}
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
            <XAxis dataKey="label" ticks={ticks} interval={0} tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} />
            <YAxis width={44} tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => (metric === "volume" ? kfmt(v) : metric === "duration" ? minfmt(v) : String(v))} allowDecimals={false} />
            <Tooltip
              cursor={{ fill: "#f3f4f6" }}
              formatter={(v) => [fmt(Number(v)), metric === "volume" ? "Volume" : metric === "workouts" ? "Workouts" : "Duration"]}
              labelStyle={{ fontSize: 12 }}
              contentStyle={{ borderRadius: 12, border: "1px solid #e5e7eb", fontSize: 12 }}
            />
            <Bar dataKey="value" fill={INK} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
