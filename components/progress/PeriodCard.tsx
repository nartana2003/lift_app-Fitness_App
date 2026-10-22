"use client";

import { useMemo, useState } from "react";
import { BodyMap } from "@/components/MuscleIcon";
import { useCatalogue } from "@/lib/catalogue";
import { MUSCLE_GROUPS } from "@/lib/muscles";
import { isoWeek, periodStats, type WorkoutLite } from "@/lib/progress";
import { addDays, addMonths, compare, formatDuration, startOfMonth, startOfWeek, type Delta } from "@/lib/stats";
import { fmtVolume, type Unit } from "@/lib/units";
import { Segmented } from "./Segmented";
import { RecapCard } from "./RecapCard";

function DeltaTag({ d }: { d: Delta }) {
  if (d.pct === null) return <span className="text-[11px] text-muted">new</span>;
  if (d.diff === 0) return <span className="text-[11px] text-muted">same as last</span>;
  const up = d.diff > 0;
  return (
    <span className={`text-[11px] font-semibold ${up ? "text-text" : "text-muted"}`}>
      {up ? "▲" : "▼"} {Math.abs(Math.round(d.pct))}%
    </span>
  );
}

/** "This week" / "This month": body map, comparison with the previous period, sets per muscle. */
export function PeriodCard({ workouts, unit, weekStart }: { workouts: WorkoutLite[]; unit: Unit; weekStart: 0 | 1 }) {
  const [mode, setMode] = useState<"week" | "month">("week");
  const { get } = useCatalogue();

  const { cur, prev, title, sub, from, to } = useMemo(() => {
    const now = new Date();
    const muscleOf = (id: string) => get(id)?.muscle_groups ?? [];
    if (mode === "week") {
      const from = startOfWeek(now, weekStart);
      const prevFrom = addDays(from, -7);
      return {
        cur: periodStats(workouts, from, addDays(from, 7), muscleOf),
        prev: periodStats(workouts, prevFrom, from, muscleOf),
        title: "This week",
        sub: `Week ${isoWeek(from)}`,
        from,
        to: addDays(from, 7),
      };
    }
    const from = startOfMonth(now);
    const prevFrom = addMonths(from, -1);
    return {
      cur: periodStats(workouts, from, addMonths(from, 1), muscleOf),
      prev: periodStats(workouts, prevFrom, from, muscleOf),
      title: "This month",
      sub: from.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      from,
      to: addMonths(from, 1),
    };
  }, [workouts, mode, weekStart, get]);

  const cmp = compare(cur, prev);
  const sets = Object.entries(cur.sets_by_muscle).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...sets.map(([, n]) => n));
  const notHit = MUSCLE_GROUPS.filter((m) => !cur.sets_by_muscle[m]);

  return (
    <section className="card p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
          <p className="text-lg font-semibold text-muted">{sub}</p>
        </div>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
        />
      </div>

      <div className="my-4">
        <BodyMap setsByGroup={cur.sets_by_muscle} />
        <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted">
          Less
          {["#9ca3af", "#6b7280", "#374151", "#111111"].map((c) => (
            <span key={c} className="size-3 rounded-sm" style={{ background: c }} />
          ))}
          More
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center border-y border-border py-3">
        <div>
          <p className="text-xl font-bold">{cmp.sessions.current}</p>
          <p className="text-xs text-muted">workouts</p>
          <DeltaTag d={cmp.sessions} />
        </div>
        <div>
          <p className="text-xl font-bold">{formatDuration(cmp.duration.current)}</p>
          <p className="text-xs text-muted">time</p>
          <DeltaTag d={cmp.duration} />
        </div>
        <div>
          <p className="text-xl font-bold">{fmtVolume(cmp.volume.current, unit)}</p>
          <p className="text-xs text-muted">volume</p>
          <DeltaTag d={cmp.volume} />
        </div>
      </div>
      <p className="text-[11px] text-muted mt-1.5 text-center">vs last {mode}</p>

      <h3 className="font-semibold mt-4 mb-2">
        Muscles hit <span className="text-muted font-normal">· {sets.length} of {MUSCLE_GROUPS.length}</span>
      </h3>
      {sets.length === 0 ? (
        <p className="text-sm text-muted">Nothing logged this {mode} yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {sets.map(([m, n]) => (
            <li key={m} className="flex items-center gap-2 text-sm">
              <span className="w-28 shrink-0 truncate">{m}</span>
              <span className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${(n / max) * 100}%` }} />
              </span>
              <span className="w-12 text-right text-muted text-xs">{n} sets</span>
            </li>
          ))}
        </ul>
      )}

      {notHit.length > 0 && sets.length > 0 && (
        <>
          <h3 className="font-semibold mt-4 mb-2">Not hit yet</h3>
          <div className="flex flex-wrap gap-1.5">
            {notHit.map((m) => (
              <span key={m} className="chip text-xs text-muted">{m}</span>
            ))}
          </div>
        </>
      )}

      <RecapCard key={mode} period={mode} unit={unit} current={cur} previous={prev} workouts={workouts} from={from} to={to} />
    </section>
  );
}
