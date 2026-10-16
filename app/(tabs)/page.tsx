"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { startWorkout } from "@/lib/workout";
import { HistoryList } from "@/components/HistoryList";
import { RoutineList } from "@/components/routines/RoutineList";
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
  const week = useLiveQuery(() => {
    const from = startOfWeek(new Date(), weekStart);
    return workoutsBetween(from, addDays(from, 7));
  }, [weekStart]);

  const sessions = week?.length ?? 0;
  const duration = week?.reduce((a, w) => a + (Date.parse(w.ended_at!) - Date.parse(w.started_at)) / 1000, 0) ?? 0;
  const volume = week?.reduce((a, w) => a + w.volume, 0) ?? 0;
  const hour = new Date().getHours();

  return (
    <>
      <header className="py-4">
        <h1 className="text-3xl font-bold tracking-tight">
          Good {hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}
        </h1>
      </header>

      {active ? (
        <Link href="/workout" className="btn-primary w-full text-lg py-4">
          Resume workout
        </Link>
      ) : (
        <button
          className="btn-primary w-full text-lg py-4"
          onClick={async () => {
            await startWorkout();
            router.push("/workout");
          }}
        >
          Start Workout
        </button>
      )}

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

      <RoutineList />

      <HistoryList />
    </>
  );
}
