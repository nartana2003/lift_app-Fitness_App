"use client";

import { useState } from "react";
import { ExerciseDemo } from "../ExerciseDemo";
import { useCatalogue } from "@/lib/catalogue";
import { searchExercises, type Exercise } from "@/lib/exercises";
import { swapOptions, SWAP_REASONS, type SwapReason } from "@/lib/swap";

/** "Machine busy?" — pick a replacement that trains the same muscle. */
export function SwapSheet({
  current,
  onPick,
  onClose,
}: {
  current: Exercise;
  onPick: (e: Exercise) => void;
  onClose: () => void;
}) {
  const { exercises } = useCatalogue();
  const [reason, setReason] = useState<SwapReason>("busy");
  const [q, setQ] = useState("");

  const options = q.trim()
    ? searchExercises(exercises, { q }).filter((e) => e.id !== current.id).slice(0, 8)
    : swapOptions(exercises, current, reason, 6);

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-end" onClick={onClose}>
      <div className="w-full max-w-lg mx-auto card rounded-b-none p-5 pb-safe max-h-[85dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Swap {current.name}</h2>
        <p className="text-xs text-muted mb-3">{current.muscle_groups.join(", ")}</p>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {SWAP_REASONS.map((r) => (
            <button key={r.v} className={reason === r.v ? "chip-on text-xs" : "chip text-xs"} onClick={() => { setReason(r.v); setQ(""); }}>
              {r.label}
            </button>
          ))}
        </div>

        <input className="field mb-3 py-2 text-sm" placeholder="Or search for one" value={q} onChange={(e) => setQ(e.target.value)} />

        <ul className="space-y-2">
          {options.map((e) => (
            <li key={e.id}>
              <button className="w-full flex items-center gap-3 rounded-xl bg-surface-2 p-2.5 text-left" onClick={() => onPick(e)}>
                <ExerciseDemo urls={e.image_urls.slice(0, 1)} alt={e.name} small />
                <span className="flex-1 min-w-0">
                  <span className="block font-medium text-sm truncate">{e.name}</span>
                  <span className="block text-xs text-muted truncate">
                    {e.equipment} · {e.muscle_groups.join(", ")}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {options.length === 0 && <li className="text-sm text-muted">No alternatives found.</li>}
        </ul>

        <button className="btn-ghost w-full mt-3" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
