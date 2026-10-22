"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/offline/db";
import { useCatalogue } from "@/lib/catalogue";
import { addExercises, discardWorkout, finishWorkout } from "@/lib/workout";
import { restTimer, fmtClock } from "@/lib/restTimer";
import { useSettings } from "@/lib/settings";
import { dispNum } from "@/lib/units";
import type { PrType } from "@/lib/prs";
import { ExerciseCard, prText } from "@/components/workout/ExerciseCard";
import { ExercisePicker } from "@/components/workout/ExercisePicker";
import { PrToast } from "@/components/workout/PrToast";
import { QuickLog } from "@/components/workout/QuickLog";
import { SaveRoutineSheet } from "@/components/routines/SaveRoutineSheet";
import { routineExercisesFromActive, type RoutineExerciseInput } from "@/lib/routines";
import { RestTimer } from "@/components/RestTimer";

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const h = Math.floor(sec / 3600);
  return <span className="tabular-nums">{h > 0 ? `${h}:${fmtClock(sec % 3600).padStart(5, "0")}` : fmtClock(sec)}</span>;
}

export default function WorkoutPage() {
  const router = useRouter();
  const { unit } = useSettings();
  const active = useLiveQuery(() => db.active.get("active"), [], null);
  const { get } = useCatalogue();
  const [picker, setPicker] = useState(false);
  const [pr, setPr] = useState<{ title: string; detail: string } | null>(null);
  const [finishedId, setFinishedId] = useState<string | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [saveRoutine, setSaveRoutine] = useState<{ exercises: RoutineExerciseInput[]; name: string } | null>(null);
  const clearPr = useCallback(() => setPr(null), []);

  const leaving = useRef(false);
  // Workouts are started from Home; with nothing running there's nothing to show here.
  useEffect(() => {
    if (active === undefined && !leaving.current) router.replace("/");
  }, [active, router]);

  if (!active) {
    // The workout is saved; the "save as routine?" sheet is still open over it.
    return saveRoutine ? (
      <SaveRoutineSheet
        exercises={saveRoutine.exercises}
        defaultName={saveRoutine.name || undefined}
        onClose={() => router.push(finishedId ? `/history/${finishedId}` : "/")}
      />
    ) : null;
  }

  const doneSets = active.exercises.flatMap((e) => e.sets).filter((s) => s.done).length;
  const volume = active.exercises
    .flatMap((e) => e.sets)
    .filter((s) => s.done && !s.is_warmup)
    .reduce((a, s) => a + (Number(s.reps) || 0) * (Number(s.weight) || 0), 0);

  async function finish() {
    if (!active) return;
    restTimer.stop();
    // Offer to save it as a routine, unless it already came from one.
    const asRoutine = active.routine_id ? [] : routineExercisesFromActive(active);
    leaving.current = true;
    const id = await finishWorkout();
    if (id && asRoutine.length > 0) {
      setConfirmFinish(false);
      setFinishedId(id);
      setSaveRoutine({ exercises: asRoutine, name: active.name ?? "" });
      return;
    }
    router.push(id ? `/history/${id}` : "/");
  }

  return (
    <>
      <header className="sticky top-0 z-20 -mx-4 px-4 pt-safe pb-3 bg-bg/95 backdrop-blur border-b border-border">
        <div className="flex items-center gap-3">
          <button className="-ml-1 p-1 text-muted" onClick={() => router.push("/")} aria-label="Minimise workout">
            <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          <div className="flex-1">
            <p className="text-xs text-muted">{active.name ?? "Workout"}</p>
            <p className="text-2xl font-bold"><Elapsed since={active.started_at} /></p>
          </div>
          <div className="text-right text-xs text-muted">
            <p>{doneSets} sets</p>
            <p>{Math.round(dispNum(volume, unit)).toLocaleString()} {unit}</p>
          </div>
          <button className="btn-primary py-2" onClick={() => setConfirmFinish(true)}>Finish</button>
        </div>
      </header>

      <div className="space-y-3 mt-3">
        {active.exercises.map((ex) => (
          <ExerciseCard
            key={ex.id}
            ex={ex}
            info={get(ex.exercise_id)}
            onPr={(name, prs: PrType[]) => setPr({ title: name, detail: prText(prs) })}
          />
        ))}
      </div>

      <button className="btn-ghost w-full mt-3 py-4 border border-dashed border-border" onClick={() => setPicker(true)}>
        + Add exercise
      </button>

      <QuickLog unit={unit} nameOf={(id) => get(id)?.name} />

      <button
        className="w-full mt-6 text-sm text-bad py-3"
        onClick={async () => {
          if (confirm("Discard this workout? Nothing will be saved.")) {
            restTimer.stop();
            leaving.current = true;
            await discardWorkout();
            router.replace("/");
          }
        }}
      >
        Discard workout
      </button>

      <RestTimer />
      {pr && <PrToast title={pr.title} detail={pr.detail} onDone={clearPr} />}
      {picker && (
        <ExercisePicker
          onClose={() => setPicker(false)}
          onAdd={async (ids) => {
            await addExercises(ids);
            setPicker(false);
          }}
        />
      )}

      {confirmFinish && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={() => setConfirmFinish(false)}>
          <div className="w-full max-w-lg mx-auto card rounded-b-none p-5 pb-safe space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">Finish workout?</h2>
            <p className="text-sm text-muted">
              {doneSets} completed sets will be saved.
              {active.exercises.some((e) => e.sets.some((s) => !s.done)) && " Unticked sets are dropped."}
            </p>
            <button className="btn-primary w-full" onClick={finish}>Save workout</button>
            <button className="btn-ghost w-full" onClick={() => setConfirmFinish(false)}>Keep going</button>
          </div>
        </div>
      )}
    </>
  );
}
