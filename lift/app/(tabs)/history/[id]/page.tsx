"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { PageHeader } from "@/components/PageHeader";
import { useCatalogue } from "@/lib/catalogue";
import { db, type SetRow } from "@/lib/offline/db";
import { deleteWorkout, enqueue } from "@/lib/offline/sync";
import { allWorkouts, workoutDetail } from "@/lib/history";
import { formatDuration } from "@/lib/stats";
import { WeightInput } from "@/components/WeightInput";
import { useSettings } from "@/lib/settings";
import { dispNum, fmtVolume } from "@/lib/units";
import { SaveRoutineSheet } from "@/components/routines/SaveRoutineSheet";
import { repRangeFrom } from "@/lib/routines";
import { exerciseThumb, recordsBySet, recordsByWorkout } from "@/lib/homeFeed";
import { e1rm, type PrType } from "@/lib/prs";
import { BodyMap } from "@/components/MuscleIcon";
import { TrophyIcon } from "@/components/HistoryList";

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
  // Records compare against every earlier workout, like the Home list.
  const records = useLiveQuery(async () => {
    const all = await allWorkouts();
    return { perWorkout: recordsByWorkout(all), perSet: recordsBySet(all) };
  }, []);

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
    // Write and queue in one transaction, so a pull cannot land in between.
    await db.transaction("rw", db.sets, db.outbox, async () => {
      await db.sets.put(row);
      await enqueue([{ table: "sets", op: "upsert", row }]);
    });
  }

  return (
    <>
      <PageHeader
        title={w.notes || "Workout"}
        back="/"
        right={
          <div className="flex items-center gap-2">
            <button className="text-sm text-accent" onClick={() => setEditing(!editing)}>
              {editing ? "Done" : "Edit"}
            </button>
            <button className="p-1 text-muted" onClick={() => setMenu(!menu)} aria-label="More options">
              <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
                <circle cx="12" cy="5" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="12" cy="19" r="1.8" />
              </svg>
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
        {start.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} ·{" "}
        {start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
      </p>

      <div className="flex items-center gap-3 mb-6">
        <div className="min-w-0 flex-1">
          <BodyMap setsByGroup={Object.fromEntries(muscles)} className="h-44" />
        </div>
        <div className="w-[36%] shrink-0 space-y-4">
          <Stat label="Duration" value={formatDuration(dur)} />
          <Stat label="Volume" value={fmtVolume(w.volume, unit)} />
          <div>
            <p className="text-[11px] text-muted">Records</p>
            <p className="text-lg font-semibold inline-flex items-center gap-1">
              <TrophyIcon />
              {records?.perWorkout.get(w.id) ?? 0}
            </p>
          </div>
        </div>
      </div>

      <h2 className="text-lg font-semibold mb-3">Exercises</h2>
      <div className="space-y-3">
        {w.exercises.map((e) => {
          const info = get(e.exercise_id);
          const name = info?.name ?? e.exercise_id;
          const thumb = exerciseThumb(info?.image_urls, name);
          const working = e.sets.filter((x) => !x.is_warmup).length || e.sets.length;
          const earned = records?.perSet.get(e.id);
          return (
            <section key={e.id} className="card p-4" aria-label={name}>
              <div className="flex items-center gap-3">
                {thumb.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumb.src} alt={name} loading="lazy" className="size-14 shrink-0 rounded-xl object-cover bg-white border border-border" />
                ) : (
                  <span aria-hidden className="size-14 shrink-0 rounded-xl bg-surface-2 text-muted flex items-center justify-center text-xl font-semibold">
                    {thumb.letter}
                  </span>
                )}
                <div className="min-w-0">
                  <h3 className="font-semibold leading-tight">{name}</h3>
                  <p className="text-sm text-muted">
                    {working} set{working === 1 ? "" : "s"}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-[1.5rem_1fr_auto] gap-x-3 px-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">
                <span>Set</span>
                <span>Weight &amp; reps</span>
                <span>1RM</span>
              </div>
              <ul className="mt-1">
                {e.sets.map((s, i) => (
                  <li key={s.id} className={`grid grid-cols-[1.5rem_1fr_auto] gap-x-3 items-start rounded-lg px-2 py-2 ${i % 2 === 1 ? "bg-surface-2" : ""}`}>
                    <span className="text-sm font-semibold text-muted">{s.is_warmup ? "W" : i + 1}</span>
                    <div className="min-w-0">
                      {editing ? (
                        <div className="flex items-center gap-2">
                          <WeightInput
                            className="field w-20 py-1 text-center"
                            kg={s.weight}
                            unit={unit}
                            onChangeKg={(kg) => void saveSet(s, { weight: kg === "" ? 0 : kg })}
                          />
                          <span className="text-muted">×</span>
                          <input className="field w-16 py-1 text-center" inputMode="numeric" defaultValue={s.reps}
                            onBlur={(ev) => saveSet(s, { reps: Number(ev.target.value) || 0 })} />
                        </div>
                      ) : (
                        <p className="text-sm font-medium">{dispNum(s.weight, unit)}{unit} × {s.reps}</p>
                      )}
                      {!!earned?.[i]?.length && (
                        <ul className="flex flex-wrap gap-1 mt-1" aria-label="Records">
                          {earned[i].map((t) => (
                            <li key={t} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-medium">
                              <TrophyIcon />
                              {PR_SHORT[t]}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <span className="text-sm font-semibold tabular-nums text-right">
                      {s.is_warmup || s.reps <= 0 ? "–" : dispNum(e1rm(s.weight, s.reps), unit)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <button
        className="w-full mt-8 flex items-center justify-center gap-2 rounded-xl border border-border text-sm font-semibold text-bad py-3.5"
        onClick={async () => {
          if (confirm("Delete this workout permanently?")) {
            await deleteWorkout(w.id);
            router.replace("/");
          }
        }}
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5L18 7M9 7V4.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V7" />
        </svg>
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

const PR_SHORT: Record<PrType, string> = { weight: "Weight", reps: "Reps", e1rm: "1RM", volume: "Volume" };

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-muted">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
