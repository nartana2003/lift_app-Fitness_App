"use client";

import { useState } from "react";
import { MUSCLE_GROUPS, type MuscleGroup } from "@/lib/muscles";
import { clearSplit, PRESETS, saveSplit, splitGaps, useSplit, type Split } from "@/lib/splits";

/** Build a split: name each day and tick the muscles it covers. */
export function SplitEditor() {
  const split = useSplit();
  const [editing, setEditing] = useState<number | null>(null);
  const has = split.days.length > 0;

  const update = (next: Split) => saveSplit(next);
  const setDay = (i: number, patch: Partial<{ name: string; muscles: MuscleGroup[] }>) =>
    update({ ...split, days: split.days.map((d, idx) => (idx === i ? { ...d, ...patch } : d)) });

  const toggleMuscle = (i: number, m: MuscleGroup) => {
    const day = split.days[i];
    setDay(i, { muscles: day.muscles.includes(m) ? day.muscles.filter((x) => x !== m) : [...day.muscles, m] });
  };

  const gaps = splitGaps(split, MUSCLE_GROUPS);

  if (!has) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">Pick a split to start from, or build your own.</p>
        <div className="space-y-2">
          {PRESETS.map((p) => (
            <button key={p.name} className="w-full text-left rounded-xl bg-surface-2 p-3" onClick={() => update(p)}>
              <span className="block font-semibold text-sm">{p.name}</span>
              <span className="block text-xs text-muted">{p.days.map((d) => d.name).join(" · ")}</span>
            </button>
          ))}
        </div>
        <button
          className="btn-ghost w-full"
          onClick={() => update({ name: "My split", days: [{ name: "Day 1", muscles: [] }] })}
        >
          Build my own
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <input className="field" value={split.name} placeholder="Split name" onChange={(e) => update({ ...split, name: e.target.value })} />

      <ul className="space-y-2">
        {split.days.map((d, i) => (
          <li key={i} className="rounded-xl bg-surface-2 p-3">
            <div className="flex items-center gap-2">
              <input
                className="field flex-1 py-1.5 bg-surface"
                value={d.name}
                onChange={(e) => setDay(i, { name: e.target.value })}
              />
              <button
                className="text-xs text-bad px-1"
                onClick={() => update({ ...split, days: split.days.filter((_, idx) => idx !== i) })}
              >
                Remove
              </button>
            </div>
            <button className="text-xs text-muted underline mt-1.5" onClick={() => setEditing(editing === i ? null : i)}>
              {d.muscles.length ? d.muscles.join(", ") : "Pick muscles"}
            </button>
            {editing === i && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {MUSCLE_GROUPS.map((m) => (
                  <button key={m} className={d.muscles.includes(m) ? "chip-on text-xs" : "chip text-xs bg-surface"} onClick={() => toggleMuscle(i, m)}>
                    {m}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>

      <button
        className="btn-ghost w-full py-2 text-sm"
        onClick={() => update({ ...split, days: [...split.days, { name: `Day ${split.days.length + 1}`, muscles: [] }] })}
      >
        + Add day
      </button>

      {gaps.missing.length > 0 && (
        <p className="text-xs text-muted">
          Not covered by any day: {gaps.missing.join(", ")}.
        </p>
      )}

      <button className="text-xs text-muted underline" onClick={() => confirm("Clear this split?") && clearSplit()}>
        Clear split
      </button>
    </div>
  );
}
