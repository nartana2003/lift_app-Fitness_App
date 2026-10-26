"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { MUSCLE_GROUPS, type MuscleGroup } from "@/lib/muscles";
import { clearSplit, PRESETS, saveSplit, splitGaps, useSplit, type Split, type SplitDay } from "@/lib/splits";
import { linkRoutineToDay, listRoutines, type Routine } from "@/lib/routines";
import { routinesForDay, unassignedRoutines } from "@/lib/splitRoutines";
import { startRoutine } from "@/components/routines/RoutineList";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The question asked before removing a day that has routines (null: nothing to ask). */
export function removeDayQuestion(dayName: string, linked: number): string | null {
  if (linked === 0) return null;
  return `Remove ${dayName.trim() || "this day"}? ${plural(linked, "routine")} will become unassigned. Nothing is deleted.`;
}

/** The question asked before clearing (or replacing) the split. */
export function clearSplitQuestion(linked: number): string {
  if (linked === 0) return "Clear this split?";
  return `Clear this split? ${plural(linked, "routine")} will become unassigned. Nothing is deleted.`;
}

/** Routines linked to one split day: Start, Edit, Remove from this day, and Add routine. */
function DayRoutines({ day, routines, unassigned }: { day: SplitDay & { id: string }; routines: Routine[]; unassigned: Routine[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const linked = routinesForDay(routines, day.id, { includeMini: true });

  async function start(r: Routine) {
    if (busy) return;
    setBusy(r.id);
    try {
      if (await startRoutine(r)) router.push("/workout");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div role="group" aria-label={`Routines for ${day.name || "this day"}`} className="mt-2 space-y-1.5">
      {linked.length === 0 ? (
        <p className="text-xs text-muted">No routine: pick exercises from your pool on the day.</p>
      ) : (
        <ul className="space-y-1.5">
          {linked.map((r) => (
            <li key={r.id} className="rounded-lg bg-surface p-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold leading-tight truncate">{r.name}</p>
                  <p className="text-xs text-muted">{plural(r.exercises.length, "exercise")}</p>
                </div>
                <button
                  type="button"
                  className="btn-primary px-3 py-1.5 text-xs"
                  disabled={busy === r.id}
                  onClick={() => start(r)}
                >
                  {busy === r.id ? "Starting…" : "Start"}
                </button>
                <Link href={`/routines/${r.id}`} className="text-xs font-semibold underline px-1">
                  Edit
                </Link>
              </div>
              <button type="button" className="text-xs text-muted underline mt-1" onClick={() => linkRoutineToDay(r.id, null)}>
                Remove from this day
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="rounded-lg bg-surface p-2 space-y-2">
          <Link href={`/routines/new?day=${encodeURIComponent(day.id)}`} className="block text-sm font-semibold underline">
            New routine for this day
          </Link>
          {unassigned.length > 0 ? (
            <select
              className="field py-1.5 text-sm"
              aria-label="Attach a routine"
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  void linkRoutineToDay(e.target.value, day.id);
                  setAdding(false);
                }
              }}
            >
              <option value="">Attach an unassigned routine</option>
              {unassigned.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-muted">No unassigned routines to attach.</p>
          )}
          <button type="button" className="text-xs text-muted underline" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="text-xs font-semibold underline" onClick={() => setAdding(true)}>
          + Add routine
        </button>
      )}
    </div>
  );
}

/** Build a split: name each day and tick the muscles it covers. */
export function SplitEditor() {
  const split = useSplit();
  const routines = useLiveQuery(() => listRoutines(), []) ?? [];
  const [editing, setEditing] = useState<number | null>(null);
  const has = split.days.length > 0;

  const update = (next: Split) => saveSplit(next);
  const setDay = (i: number, patch: Partial<{ name: string; muscles: MuscleGroup[] }>) =>
    update({ ...split, days: split.days.map((d, idx) => (idx === i ? { ...d, ...patch } : d)) });

  const toggleMuscle = (i: number, m: MuscleGroup) => {
    const day = split.days[i];
    setDay(i, { muscles: day.muscles.includes(m) ? day.muscles.filter((x) => x !== m) : [...day.muscles, m] });
  };

  // Removing a day unlinks its routines (they are kept), so ask first when it has any.
  const removeDay = (i: number) => {
    const d = split.days[i];
    const q = removeDayQuestion(d.name, d.id ? routinesForDay(routines, d.id, { includeMini: true }).length : 0);
    if (q && !confirm(q)) return;
    void update({ ...split, days: split.days.filter((_, idx) => idx !== i) });
  };

  const unassigned = unassignedRoutines(routines, split);
  const linkedCount = routines.length - unassigned.length;

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
          <li key={d.id ?? i} className="rounded-xl bg-surface-2 p-3">
            <div className="flex items-center gap-2">
              <input
                className="field flex-1 py-1.5 bg-surface"
                value={d.name}
                onChange={(e) => setDay(i, { name: e.target.value })}
              />
              <button className="text-xs text-bad px-1" onClick={() => removeDay(i)}>
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
            {d.id && <DayRoutines day={{ ...d, id: d.id }} routines={routines} unassigned={unassigned} />}
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

      <button className="text-xs text-muted underline" onClick={() => confirm(clearSplitQuestion(linkedCount)) && clearSplit()}>
        Clear split
      </button>
    </div>
  );
}
