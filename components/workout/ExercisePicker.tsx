"use client";

import { useState } from "react";
import { ExerciseBrowser } from "../ExerciseBrowser";
import { useCatalogue } from "@/lib/catalogue";

/** Full-screen sheet: browse like the Exercises tab, tap cards to select, then "Add N". */
export function ExercisePicker({ onAdd, onClose }: { onAdd: (ids: string[]) => void; onClose: () => void }) {
  const { exercises } = useCatalogue();
  const [muscle, setMuscle] = useState<string | undefined>();
  const [picked, setPicked] = useState<string[]>([]);

  return (
    <div className="fixed inset-0 z-50 bg-bg overflow-y-auto">
      <div className="max-w-lg mx-auto px-4 pt-safe pb-32">
        <header className="flex items-center justify-between py-3">
          <button className="text-muted" onClick={onClose}>Cancel</button>
          <h2 className="font-semibold">Add exercises</h2>
          <span className="w-12" />
        </header>
        <ExerciseBrowser
          exercises={exercises}
          muscle={muscle}
          onMuscle={setMuscle}
          picked={picked}
          onPick={(e) => setPicked((cur) => (cur.includes(e.id) ? cur.filter((x) => x !== e.id) : [...cur, e.id]))}
        />
      </div>
      {picked.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 p-4 pb-safe bg-bg/95 border-t border-border">
          <button className="btn-primary w-full max-w-lg mx-auto flex" onClick={() => onAdd(picked)}>
            Add {picked.length} exercise{picked.length > 1 ? "s" : ""}
          </button>
        </div>
      )}
    </div>
  );
}
