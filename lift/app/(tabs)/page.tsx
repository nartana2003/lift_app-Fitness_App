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
import { dayKey, getDay } from "@/lib/planner";
import { addDays, delta, formatDuration, startOfWeek } from "@/lib/stats";
import { useSettings } from "@/lib/settings";
import { dispNum } from "@/lib/units";

const seconds = (w: { started_at: string; ended_at: string | null }) => (Date.parse(w.ended_at!) - Date.parse(w.started_at)) / 1000;

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
  const prev = useLiveQuery(() => {
    const from = startOfWeek(new Date(), weekStart);
    return workoutsBetween(addDays(from, -7), from);
  }, [weekStart]);
  const today = dayKey(new Date());
  // The routine planned for today on the This Week strip, if any.
  const plannedId = useLiveQuery(async () => {
    const row = await getDay(today);
    return row && row.status === "planned" ? row.routine_id : null;
  }, [today]);
  const planned = routines.find((r) => r.id === plannedId) ?? null;

  const sessions = week?.length ?? 0;
  const duration = week?.reduce((a, w) => a + seconds(w), 0) ?? 0;
  const volume = week?.reduce((a, w) => a + w.volume, 0) ?? 0;
  const dSessions = delta(sessions, prev?.length ?? 0).diff;
  const dDuration = delta(duration, prev?.reduce((a, w) => a + seconds(w), 0) ?? 0).diff;
  const dVolume = delta(volume, prev?.reduce((a, w) => a + w.volume, 0) ?? 0).diff;

  return (
    <>
      <section className="card p-4 mt-4">
        <h2 className="font-semibold mb-3">My Week</h2>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-2xl font-bold">{sessions}</p>
            <p className="text-xs text-muted">workouts</p>
            <Change diff={dSessions} text={String(Math.abs(dSessions))} />
          </div>
          <div>
            <p className="text-2xl font-bold">{formatDuration(duration)}</p>
            <p className="text-xs text-muted">time</p>
            <Change diff={dDuration} text={formatDuration(Math.abs(dDuration))} />
          </div>
          <div>
            <p className="text-2xl font-bold">{Math.round(dispNum(volume, unit)).toLocaleString()}</p>
            <p className="text-xs text-muted">{unit} volume</p>
            <Change diff={dVolume} text={Math.round(dispNum(Math.abs(dVolume), unit)).toLocaleString()} />
          </div>
        </div>
      </section>

      {/* Floating action button above the tab bar, like Lyfta. Extras stack above it. */}
      <div className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 z-30 flex w-full max-w-lg -translate-x-1/2 flex-col-reverse items-end gap-2 px-4 pointer-events-none [&>*]:pointer-events-auto">
        {active ? (
          <Link href="/workout" className="btn-primary rounded-full px-6 py-4 text-base shadow-lg">
            <PlayIcon />
            Resume workout
          </Link>
        ) : (
          <>
            <button
              className="btn-primary rounded-full px-6 py-4 text-base shadow-lg"
              aria-expanded={choosing}
              onClick={async () => {
                if (planned) {
                  if (await startRoutine(planned)) router.push("/workout");
                  return;
                }
                if (routines.length > 0) {
                  setChoosing(!choosing);
                  return;
                }
                await startWorkout();
                router.push("/workout");
              }}
            >
              <PlayIcon />
              Start Workout
            </button>
            {planned && (
              <p className="rounded-full border border-border bg-bg px-3 py-1 text-xs text-muted shadow-sm">
                Planned today: {planned.name}.{" "}
                <button className="underline" aria-expanded={choosing} onClick={() => setChoosing(!choosing)}>
                  Choose another
                </button>
              </p>
            )}
            {choosing && (
              <div className="card w-64 max-w-full p-3 space-y-1.5 shadow-lg" role="group" aria-label="Start from">
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

      <WeekStrip />

      <HistoryList />

      {/* Keeps the last history row clear of the floating button. */}
      <div className="h-20" aria-hidden />
    </>
  );
}

function PlayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4.5v15a.8.8 0 0 0 1.2.7l12-7.5a.8.8 0 0 0 0-1.4l-12-7.5A.8.8 0 0 0 7 4.5Z" />
    </svg>
  );
}

/** Change against last week: an arrow plus the size of the change; a dash when unchanged. */
function Change({ diff, text }: { diff: number; text: string }) {
  const pill = "inline-flex items-center gap-1 rounded-full bg-border/60 px-2.5 py-0.5 text-xs font-medium mt-1.5";
  if (diff === 0) {
    return (
      <p className={`${pill} text-muted`} aria-label="No change from last week">
        -
      </p>
    );
  }
  const up = diff > 0;
  return (
    <p className={pill} aria-label={`${up ? "Up" : "Down"} ${text} from last week`}>
      <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden>
        <path d={up ? "M12 5l8 14H4z" : "M12 19L4 5h16z"} />
      </svg>
      {text}
    </p>
  );
}
