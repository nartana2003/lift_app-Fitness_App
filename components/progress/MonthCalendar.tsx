"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { dayKey, durationSec, monthGrid, workoutTitle } from "@/lib/progress";
import { formatDuration } from "@/lib/stats";
import { fmtVolume, type Unit } from "@/lib/units";
import type { WorkoutDetail } from "@/lib/history";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Month grid; days with a workout are filled in. Tap one to see its workouts. */
export function MonthCalendar({ workouts, unit, weekStart }: { workouts: WorkoutDetail[]; unit: Unit; weekStart: 0 | 1 }) {
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [picked, setPicked] = useState<string | null>(null);

  const grid = useMemo(() => monthGrid(cursor.y, cursor.m, weekStart), [cursor, weekStart]);
  const byDay = useMemo(() => {
    const m = new Map<string, WorkoutDetail[]>();
    for (const w of workouts) {
      const k = dayKey(new Date(w.started_at));
      m.set(k, [...(m.get(k) ?? []), w]);
    }
    return m;
  }, [workouts]);

  const labels = weekStart === 1 ? [...WEEKDAYS.slice(1), WEEKDAYS[0]] : WEEKDAYS;
  const today = dayKey(now);
  const move = (delta: number) => {
    setPicked(null);
    setCursor((c) => {
      const d = new Date(c.y, c.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };
  const monthCount = grid.filter((d) => d.getMonth() === cursor.m && byDay.has(dayKey(d))).length;
  const sel = picked ? byDay.get(picked) : undefined;

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-bold">
            {new Date(cursor.y, cursor.m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}
          </h2>
          <p className="text-xs text-muted">
            {monthCount} day{monthCount === 1 ? "" : "s"} trained
          </p>
        </div>
        <div className="flex gap-1">
          <button className="size-9 grid place-items-center rounded-full bg-surface-2" onClick={() => move(-1)} aria-label="Previous month">
            ‹
          </button>
          <button className="size-9 grid place-items-center rounded-full bg-surface-2" onClick={() => move(1)} aria-label="Next month">
            ›
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 text-center text-[11px] font-medium text-muted mb-1">
        {labels.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-1">
        {grid.map((d) => {
          const k = dayKey(d);
          const inMonth = d.getMonth() === cursor.m;
          const has = byDay.has(k);
          return (
            <button
              key={k}
              disabled={!has}
              onClick={() => setPicked(picked === k ? null : k)}
              className={`mx-auto size-9 rounded-full text-sm grid place-items-center ${
                has ? (picked === k ? "bg-accent text-accent-ink ring-2 ring-offset-2 ring-accent" : "bg-accent text-accent-ink") : inMonth ? "text-text" : "text-border"
              } ${k === today && !has ? "ring-1 ring-accent" : ""}`}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      {sel && (
        <ul className="mt-3 space-y-2">
          {sel.map((w) => (
            <li key={w.id}>
              <Link href={`/history/${w.id}`} className="block rounded-xl bg-surface-2 px-3 py-2">
                <p className="font-semibold text-sm">{workoutTitle(w)}</p>
                <p className="text-xs text-muted">
                  {formatDuration(durationSec(w))} · {fmtVolume(w.volume, unit)} · {w.setCount} sets
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
