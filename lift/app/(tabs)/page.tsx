"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { startWorkout } from "@/lib/workout";
import { HistoryList } from "@/components/HistoryList";
import { startRoutine } from "@/components/routines/RoutineList";
import { listRoutines } from "@/lib/routines";
import { WeekStrip } from "@/components/planner/WeekStrip";
import { db } from "@/lib/offline/db";
import { workoutsBetween } from "@/lib/history";
import { addDays, formatDuration, startOfWeek } from "@/lib/stats";
import { useSettings } from "@/lib/settings";
import { dispNum } from "@/lib/units";

export default function Home() {
  const router = useRouter();
  const { unit, weekStart } = useSettings();
  const active = useLiveQuery(() => db.active.get("active"), []);
  const routines = useLiveQuery(listRoutines, [], []).filter((r) => (r.kind ?? "routine") === "routine");
  const [choosing, setChoosing] = useState(false);
  const [pickingRoutine, setPickingRoutine] = useState(false);
  const week = useLiveQuery(() => {
    const from = startOfWeek(new Date(), weekStart);
    return workoutsBetween(from, addDays(from, 7));
  }, [weekStart]);

  const sessions = week?.length ?? 0;
  const duration = week?.reduce((a, w) => a + (Date.parse(w.ended_at!) - Date.parse(w.started_at)) / 1000, 0) ?? 0;
  const volume = week?.reduce((a, w) => a + w.volume, 0) ?? 0;

  return (
    <>
      <div className="pt-4">
        {active ? (
          <Link href="/workout" className="btn-primary w-full text-lg py-4 rounded-full">
            Resume workout
          </Link>
        ) : (
          <>
            <button
              className="btn-primary w-full text-lg py-4 rounded-full"
              aria-expanded={choosing}
              onClick={async () => {
                if (routines.length > 0) {
                  setChoosing(!choosing);
                  return;
                }
                await startWorkout();
                router.push("/workout");
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Start Workout
            </button>
            {choosing && (
              <div className="card p-3 mt-2 space-y-1.5" role="group" aria-label="Start from">
                <button
                  className="w-full text-left rounded-xl border border-border px-3 py-2.5 text-sm font-medium"
                  onClick={async () => {
                    await startWorkout();
                    router.push("/workout");
                  }}
                >
                  Empty workout
                </button>
                <button
                  className="w-full flex items-center justify-between rounded-xl border border-border px-3 py-2.5 text-sm font-medium"
                  aria-expanded={pickingRoutine}
                  onClick={() => setPickingRoutine(!pickingRoutine)}
                >
                  Start Routine
                  <svg
                    viewBox="0 0 24 24"
                    className={`size-4 text-muted transition-transform ${pickingRoutine ? "rotate-180" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                {pickingRoutine && (
                  <div className="space-y-1.5 pl-3" role="group" aria-label="Routines">
                    {routines.map((r) => (
                      <button
                        key={r.id}
                        className="w-full text-left rounded-xl border border-border px-3 py-2.5 text-sm font-medium"
                        onClick={async () => {
                          if (await startRoutine(r)) router.push("/workout");
                        }}
                      >
                        {r.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <section className="card p-4 mt-4">
        <h2 className="font-semibold mb-3">My Week</h2>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-2xl font-bold">{sessions}</p>
            <p className="text-xs text-muted">workouts</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{formatDuration(duration)}</p>
            <p className="text-xs text-muted">time</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{Math.round(dispNum(volume, unit)).toLocaleString()}</p>
            <p className="text-xs text-muted">{unit} volume</p>
          </div>
        </div>
      </section>

      <WeekStrip />

      <HistoryList />
    </>
  );
}
