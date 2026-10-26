"use client";

import { use } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { PageHeader } from "@/components/PageHeader";
import { RoutineEditor } from "@/components/routines/RoutineEditor";
import { getRoutine } from "@/lib/routines";

export default function EditRoutinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const routine = useLiveQuery(() => getRoutine(id), [id], null);

  if (routine === null) return null;
  if (!routine) return <PageHeader title="Routine not found" back="/" />;

  return (
    <RoutineEditor
      key={routine.id}
      routineId={routine.id}
      initialName={routine.name}
      initialExercises={routine.exercises.map((e) => ({
        exercise_id: e.exercise_id,
        target_sets: e.target_sets,
        target_reps: e.target_reps,
      }))}
    />
  );
}
