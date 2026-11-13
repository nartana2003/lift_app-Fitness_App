"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { addExercises, getActive, startWorkout } from "@/lib/workout";

/** Adds the exercise to the running workout, or starts a workout with it when none is running. */
export function AddToWorkoutButton({ exerciseId }: { exerciseId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // null when no workout is running; undefined until the first read.
  const active = useLiveQuery(async () => (await getActive()) ?? null, []);
  if (active === undefined) return null;
  const inWorkout = !!active?.exercises.some((e) => e.exercise_id === exerciseId);

  async function add() {
    setBusy(true);
    try {
      if (active) await addExercises([exerciseId]);
      else {
        await startWorkout({ exercises: [{ exercise_id: exerciseId }] });
        router.push("/workout");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="btn-primary w-full mt-4" disabled={busy || inWorkout} onClick={add}>
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={inWorkout ? "M5 12l5 5L20 7" : "M12 5v14M5 12h14"} />
      </svg>
      {inWorkout ? "In your workout" : "Add to workout"}
    </button>
  );
}
