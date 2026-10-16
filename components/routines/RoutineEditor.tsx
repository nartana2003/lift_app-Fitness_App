"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { ExercisePicker } from "@/components/workout/ExercisePicker";
import { ExerciseDemo } from "@/components/ExerciseDemo";
import { useCatalogue } from "@/lib/catalogue";
import { createRoutine, deleteRoutine, updateRoutine, DEFAULT_REPS, DEFAULT_SETS, type RoutineExerciseInput } from "@/lib/routines";

type Row = Required<RoutineExerciseInput>;

const toRows = (list: RoutineExerciseInput[]): Row[] =>
  list.map((e) => ({
    exercise_id: e.exercise_id,
    target_sets: e.target_sets ?? DEFAULT_SETS,
    target_reps: e.target_reps ?? DEFAULT_REPS,
  }));

/** Create or edit a routine: name, exercises, target sets and rep range. */
export function RoutineEditor({
  routineId,
  initialName = "",
  initialExercises = [],
}: {
  routineId?: string;
  initialName?: string;
  initialExercises?: RoutineExerciseInput[];
}) {
  const router = useRouter();
  const { get } = useCatalogue();
  const [name, setName] = useState(initialName);
  const [rows, setRows] = useState<Row[]>(toRows(initialExercises));
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);

  const patch = (i: number, p: Partial<Row>) => setRows((r) => r.map((x, idx) => (idx === i ? { ...x, ...p } : x)));
  const move = (i: number, dir: -1 | 1) =>
    setRows((r) => {
      const j = i + dir;
      if (j < 0 || j >= r.length) return r;
      const copy = [...r];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  async function save() {
    setBusy(true);
    try {
      if (routineId) {
        await updateRoutine(routineId, { name, exercises: rows });
        router.push("/");
      } else {
        await createRoutine({ name, exercises: rows });
        router.push("/");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title={routineId ? "Edit routine" : "New routine"} back="/" />

      <input className="field mb-3" placeholder="Routine name (e.g. Push day)" value={name} onChange={(e) => setName(e.target.value)} />

      <ul className="space-y-2">
        {rows.map((r, i) => {
          const ex = get(r.exercise_id);
          return (
            <li key={`${r.exercise_id}-${i}`} className="card p-3">
              <div className="flex items-start gap-3">
                <ExerciseDemo urls={ex?.image_urls.slice(0, 1) ?? []} alt={ex?.name ?? ""} small />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold leading-tight">{ex?.name ?? r.exercise_id}</p>
                  <p className="text-xs text-muted">{ex?.muscle_groups.join(", ")}</p>
                </div>
                <div className="flex flex-col gap-1 text-muted">
                  <button onClick={() => move(i, -1)} aria-label="Move up" className="px-1 leading-none">↑</button>
                  <button onClick={() => move(i, 1)} aria-label="Move down" className="px-1 leading-none">↓</button>
                </div>
              </div>
              <div className="grid grid-cols-[auto_4rem_auto_6rem_1fr] items-center gap-2 mt-2 text-sm">
                <span className="text-muted text-xs">Sets</span>
                <input
                  className="field py-1.5 px-2 text-center"
                  inputMode="numeric"
                  value={r.target_sets}
                  onChange={(e) => patch(i, { target_sets: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })}
                />
                <span className="text-muted text-xs">Reps</span>
                <input
                  className="field py-1.5 px-2 text-center"
                  value={r.target_reps}
                  placeholder="8-12"
                  onChange={(e) => patch(i, { target_reps: e.target.value })}
                />
                <button className="text-xs text-bad justify-self-end" onClick={() => setRows((x) => x.filter((_, idx) => idx !== i))}>
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <button className="btn-ghost w-full mt-3 py-4 border border-dashed border-border" onClick={() => setPicker(true)}>
        + Add exercise
      </button>

      <button className="btn-primary w-full mt-4" disabled={busy || !name.trim() || rows.length === 0} onClick={save}>
        {busy ? "Saving…" : routineId ? "Save changes" : "Create routine"}
      </button>

      {routineId && (
        <button
          className="w-full mt-4 text-sm text-bad py-3"
          onClick={async () => {
            if (confirm("Delete this routine? Your logged workouts aren't affected.")) {
              await deleteRoutine(routineId);
              router.push("/");
            }
          }}
        >
          Delete routine
        </button>
      )}

      {picker && (
        <ExercisePicker
          onClose={() => setPicker(false)}
          onAdd={(ids) => {
            setRows((r) => [...r, ...ids.map((id) => ({ exercise_id: id, target_sets: DEFAULT_SETS, target_reps: DEFAULT_REPS }))]);
            setPicker(false);
          }}
        />
      )}
    </>
  );
}
