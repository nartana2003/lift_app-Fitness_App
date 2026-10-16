"use client";

import { useState } from "react";
import { useCatalogue } from "@/lib/catalogue";
import { createRoutine, type RoutineExerciseInput } from "@/lib/routines";

/** Bottom sheet: name the routine and confirm its exercises. */
export function SaveRoutineSheet({
  exercises,
  defaultName,
  onClose,
  onSaved,
}: {
  exercises: RoutineExerciseInput[];
  defaultName?: string;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const { get } = useCatalogue();
  const [name, setName] = useState(defaultName ?? suggestName());
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const id = await createRoutine({ name, exercises });
      onSaved?.(id);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-end" onClick={onClose}>
      <div className="w-full max-w-lg mx-auto card rounded-b-none p-5 pb-safe space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Save as routine</h2>
        <input
          className="field"
          autoFocus
          placeholder="Routine name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && save()}
        />
        <ul className="text-sm text-muted space-y-1 max-h-48 overflow-y-auto">
          {exercises.map((e, i) => (
            <li key={`${e.exercise_id}-${i}`} className="flex justify-between gap-2">
              <span className="truncate">{get(e.exercise_id)?.name ?? e.exercise_id}</span>
              <span className="shrink-0">
                {e.target_sets ?? 3} × {e.target_reps ?? "8-12"}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">
          Starting this routine adds these exercises with your last weights filled in.
        </p>
        <button className="btn-primary w-full" disabled={busy || !name.trim() || exercises.length === 0} onClick={save}>
          {busy ? "Saving…" : "Save routine"}
        </button>
        <button className="btn-ghost w-full" onClick={onClose}>Not now</button>
      </div>
    </div>
  );
}

function suggestName(d = new Date()) {
  const h = d.getHours();
  const part = h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
  return `${part} routine`;
}
