"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { PageHeader } from "@/components/PageHeader";
import { RIR_OPTIONS } from "@/components/workout/ExerciseCard";
import { useCatalogue } from "@/lib/catalogue";
import { db, type SetRow } from "@/lib/offline/db";
import { deleteWorkout, enqueue } from "@/lib/offline/sync";
import { workoutDetail } from "@/lib/history";
import { formatDuration } from "@/lib/stats";
import { WeightInput } from "@/components/WeightInput";
import { useSettings } from "@/lib/settings";
import { dispNum, fmtVolume } from "@/lib/units";
import { SaveRoutineSheet } from "@/components/routines/SaveRoutineSheet";
import { repRangeFrom } from "@/lib/routines";

export default function WorkoutDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { get } = useCatalogue();
  const { unit } = useSettings();
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [saveRoutine, setSaveRoutine] = useState(false);
  const w = useLiveQuery(async () => {
    const row = await db.workouts.get(id);
    return row ? workoutDetail(row) : undefined;
  }, [id], null);

  if (w === null) return null;
  if (!w) return <PageHeader title="Workout not found" back="/" />;

  const start = new Date(w.started_at);
  const dur = (Date.parse(w.ended_at!) - start.getTime()) / 1000;
  const muscles = new Map<string, number>();
  for (const e of w.exercises) {
    const n = e.sets.filter((s) => !s.is_warmup).length;
    for (const m of get(e.exercise_id)?.muscle_groups ?? []) muscles.set(m, (muscles.get(m) ?? 0) + n);
  }

  async function saveSet(s: SetRow, patch: Partial<SetRow>) {
    const row = { ...s, ...patch };
    await db.sets.put(row);
    await enqueue([{ table: "sets", op: "upsert", row }]);
  }

  return (
    <>
      <PageHeader
        title={w.notes || start.toLocaleDateString(undefined, { weekday: "long" })}
        back="/"
        right={
          <div className="flex items-center gap-2">
            <button className="text-sm text-accent" onClick={() => setEditing(!editing)}>
              {editing ? "Done" : "Edit"}
            </button>
            <button className="p-1 text-muted text-xl leading-none" onClick={() => setMenu(!menu)} aria-label="More options">
              ⋯
            </button>
          </div>
        }
      />
      {menu && (
        <div className="card p-2 mb-3">
          <button
            className="w-full text-left px-3 py-2.5 rounded-lg active:bg-surface-2"
            onClick={() => {
              setMenu(false);
              setSaveRoutine(true);
            }}
          >
            Save as routine
          </button>
        </div>
      )}

      <p className="text-sm text-muted -mt-2 mb-4">
        {start.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })} ·{" "}
        {start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
      </p>

      <div className="grid grid-cols-3 gap-2 text-center mb-4">
        <Stat label="Duration" value={formatDuration(dur)} />
        <Stat label="Sets" value={String(w.setCount)} />
        <Stat label="Volume" value={fmtVolume(w.volume, unit)} />
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {[...muscles.entries()].map(([m, n]) => (
          <span key={m} className="chip text-xs">{m} · {n}</span>
        ))}
      </div>

      <div className="space-y-3">
        {w.exercises.map((e) => (
          <section key={e.id} className="card p-3">
            <h3 className="font-semibold mb-2">{get(e.exercise_id)?.name ?? e.exercise_id}</h3>
            <ul className="space-y-1">
              {e.sets.map((s, i) => (
                <li key={s.id} className="flex items-center gap-3 text-sm">
                  <span className={`w-5 ${s.is_warmup ? "text-warn" : "text-muted"}`}>{s.is_warmup ? "W" : i + 1}</span>
                  {editing ? (
                    <>
                      <WeightInput
                        className="field w-20 py-1 text-center"
                        kg={s.weight}
                        unit={unit}
                        onChangeKg={(kg) => void saveSet(s, { weight: kg === "" ? 0 : kg })}
                      />
                      <span className="text-muted">×</span>
                      <input className="field w-16 py-1 text-center" inputMode="numeric" defaultValue={s.reps}
                        onBlur={(ev) => saveSet(s, { reps: Number(ev.target.value) || 0 })} />
                    </>
                  ) : (
                    <span className="flex-1">{dispNum(s.weight, unit)}{unit} × {s.reps}</span>
                  )}
                  {s.rir != null && <span title="Effort">{RIR_OPTIONS.find((o) => o.v === s.rir)?.emoji}</span>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <button
        className="w-full mt-8 text-sm text-bad py-3"
        onClick={async () => {
          if (confirm("Delete this workout permanently?")) {
            await deleteWorkout(w.id);
            router.replace("/");
          }
        }}
      >
        Delete workout
      </button>

      {saveRoutine && (
        <SaveRoutineSheet
          defaultName={w.notes ?? undefined}
          exercises={w.exercises.map((e) => {
            const work = e.sets.filter((x) => !x.is_warmup);
            return {
              exercise_id: e.exercise_id,
              target_sets: Math.max(1, work.length),
              target_reps: repRangeFrom(work.map((x) => x.reps)),
            };
          })}
          onClose={() => setSaveRoutine(false)}
        />
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-2.5">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className="font-semibold">{value}</p>
    </div>
  );
}
