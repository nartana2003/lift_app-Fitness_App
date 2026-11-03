"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { ExercisePicker } from "@/components/workout/ExercisePicker";
import { ExerciseDemo } from "@/components/ExerciseDemo";
import { useCatalogue } from "@/lib/catalogue";
import { createRoutine, deleteRoutine, getRoutine, updateRoutine, DEFAULT_REPS, DEFAULT_SETS, type RoutineExerciseInput } from "@/lib/routines";
import { useSplit } from "@/lib/splits";

type Row = Required<RoutineExerciseInput>;

const toRows = (list: RoutineExerciseInput[]): Row[] =>
  list.map((e) => ({
    exercise_id: e.exercise_id,
    target_sets: e.target_sets ?? DEFAULT_SETS,
    target_reps: e.target_reps ?? DEFAULT_REPS,
  }));

/** The `?day=<split day id>` a new routine was opened with (from Profile > My split), or null. */
export function dayFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get("day");
  return v && v.trim() ? v.trim() : null;
}

/**
 * Create or edit a routine: name, exercises, target sets and rep range, and the
 * split day it belongs to (optional). `initialSplitDayId` left out: an existing
 * routine's link is read from the store, and a new one takes `?day=` from the URL.
 */
export function RoutineEditor({
  routineId,
  initialName = "",
  initialExercises = [],
  initialSplitDayId,
}: {
  routineId?: string;
  initialName?: string;
  initialExercises?: RoutineExerciseInput[];
  initialSplitDayId?: string | null;
}) {
  const router = useRouter();
  const { get } = useCatalogue();
  const [name, setName] = useState(initialName);
  const [rows, setRows] = useState<Row[]>(toRows(initialExercises));
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const split = useSplit();
  // The split day this routine belongs to ("" = none), and the link it started with.
  const [dayId, setDayId] = useState<string>(initialSplitDayId ?? "");
  const [startDayId, setStartDayId] = useState<string>(initialSplitDayId ?? "");
  const dayTouched = useRef(false);

  useEffect(() => {
    if (initialSplitDayId !== undefined) return;
    let live = true;
    const apply = (id: string | null | undefined) => {
      if (!live) return;
      setStartDayId(id ?? "");
      if (!dayTouched.current) setDayId(id ?? "");
    };
    if (routineId) void getRoutine(routineId).then((r) => apply(r?.split_day_id));
    else {
      const d = dayFromSearch(window.location.search);
      if (d && !dayTouched.current) setDayId(d);
    }
    return () => {
      live = false;
    };
  }, [routineId, initialSplitDayId]);

  const days = split.days.filter((d): d is typeof d & { id: string } => !!d.id);
  // A link to a day that is no longer in the split counts as none.
  const day = days.find((d) => d.id === dayId) ?? null;
  const chosen = day?.id ?? "";

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
        const startDay = days.some((d) => d.id === startDayId) ? startDayId : "";
        await updateRoutine(routineId, {
          name,
          exercises: rows,
          ...(chosen !== startDay ? { split_day_id: chosen || null } : {}),
        });
        router.push("/");
      } else {
        await createRoutine({ name, exercises: rows, ...(chosen ? { split_day_id: chosen } : {}) });
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

      {days.length > 0 && (
        <div className="mb-3">
          <label className="block text-xs text-muted mb-1" htmlFor="routine-split-day">
            Belongs to
          </label>
          <select
            id="routine-split-day"
            className="field py-1.5 text-sm"
            value={chosen}
            onChange={(e) => {
              dayTouched.current = true;
              setDayId(e.target.value);
            }}
          >
            <option value="">None</option>
            {days.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name || "Split day"}
              </option>
            ))}
          </select>
          {day && day.muscles.length > 0 && (
            <p className="text-xs text-muted mt-1">Suggested focus: {day.muscles.join(", ")}</p>
          )}
        </div>
      )}

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
