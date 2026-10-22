"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useCatalogue } from "@/lib/catalogue";
import { listRoutines } from "@/lib/routines";
import { startWorkout } from "@/lib/workout";
import { db } from "@/lib/offline/db";
import { GeneratePlan } from "./GeneratePlan";
import { SaveFromLink } from "./SaveFromLink";
import {
  MiniWorkoutCard,
  NO_FILTER,
  filterRoutines,
  musclesIn,
  platformLabel,
  platformsIn,
  type Platform,
  type RoutineFilter,
} from "./MiniWorkoutCard";

/** "My routines" on Home: tap one to start it with your last weights pre-filled. */
export function RoutineList() {
  const router = useRouter();
  const { get } = useCatalogue();
  const routines = useLiveQuery(() => listRoutines(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<RoutineFilter>(NO_FILTER);

  if (!routines) return null;

  const musclesOf = (r: (typeof routines)[number]) => [
    ...new Set(r.exercises.flatMap((e) => get(e.exercise_id)?.muscle_groups ?? [])),
  ];
  const platformChips = platformsIn(routines);
  const muscleChips = musclesIn(routines, musclesOf);
  // A chosen chip that no longer exists (its routines were deleted) stops filtering.
  const active: RoutineFilter = {
    platform: filter.platform !== null && platformChips.includes(filter.platform) ? filter.platform : null,
    muscle: filter.muscle !== null && muscleChips.includes(filter.muscle) ? filter.muscle : null,
  };
  const filtering = active.platform !== null || active.muscle !== null;
  const shown = filterRoutines(routines, active, musclesOf);
  const pickPlatform = (p: Platform | null) => setFilter((f) => ({ ...f, platform: f.platform === p ? null : p }));
  const pickMuscle = (m: string | null) => setFilter((f) => ({ ...f, muscle: f.muscle === m ? null : m }));

  async function start(id: string) {
    if (busy) return;
    setBusy(id);
    try {
      if (await db.active.get("active")) {
        if (!confirm("You already have a workout in progress. Discard it and start this routine?")) return;
      }
      const r = routines!.find((x) => x.id === id)!;
      await startWorkout({
        name: r.name,
        routineId: r.id,
        exercises: r.exercises.map((e) => ({
          exercise_id: e.exercise_id,
          target_sets: e.target_sets,
          target_reps: e.target_reps,
        })),
      });
      router.push("/workout");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-5">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-bold">My Routines</h2>
        <Link
          href="/routines/new"
          className="size-8 rounded-full bg-surface-2 grid place-items-center text-xl leading-none"
          aria-label="New routine"
        >
          +
        </Link>
      </div>

      {routines.length === 0 ? (
        <p className="card p-4 text-sm text-muted">No routines yet.</p>
      ) : (
        <>
        {(platformChips.length > 0 || muscleChips.length > 0) && (
          <div className="mb-2 space-y-1.5">
            {platformChips.length > 0 && (
              <div role="group" aria-label="Filter by platform" className="flex gap-2 overflow-x-auto no-scrollbar -mx-4 px-4">
                <button
                  type="button"
                  className={active.platform === null ? "chip-on text-xs shrink-0" : "chip text-xs shrink-0"}
                  aria-pressed={active.platform === null}
                  onClick={() => pickPlatform(null)}
                >
                  All sources
                </button>
                {platformChips.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={active.platform === p ? "chip-on text-xs shrink-0" : "chip text-xs shrink-0"}
                    aria-pressed={active.platform === p}
                    onClick={() => pickPlatform(p)}
                  >
                    {platformLabel(p)}
                  </button>
                ))}
              </div>
            )}
            {muscleChips.length > 0 && (
              <div role="group" aria-label="Filter by muscle" className="flex gap-2 overflow-x-auto no-scrollbar -mx-4 px-4">
                <button
                  type="button"
                  className={active.muscle === null ? "chip-on text-xs shrink-0" : "chip text-xs shrink-0"}
                  aria-pressed={active.muscle === null}
                  onClick={() => pickMuscle(null)}
                >
                  All muscles
                </button>
                {muscleChips.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={active.muscle === m ? "chip-on text-xs shrink-0" : "chip text-xs shrink-0"}
                    aria-pressed={active.muscle === m}
                    onClick={() => pickMuscle(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {filtering && shown.length === 0 ? (
          <div className="card p-4 text-sm text-muted flex items-center justify-between gap-2">
            <p>No routines match these filters.</p>
            <button type="button" className="text-text font-semibold underline shrink-0" onClick={() => setFilter(NO_FILTER)}>
              Clear filters
            </button>
          </div>
        ) : (
        <ul className="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4 pb-1">
          {shown.map((r) => {
            const muscles = musclesOf(r);
            if (r.kind === "mini") {
              return (
                <li key={r.id} className="w-56 shrink-0">
                  <MiniWorkoutCard
                    routine={r}
                    exerciseCount={r.exercises.length}
                    muscles={muscles}
                    busy={busy === r.id}
                    onStart={() => start(r.id)}
                  />
                </li>
              );
            }
            return (
              <li key={r.id} className="w-56 shrink-0">
                <div className="card h-full p-3 flex flex-col">
                  <div className="flex items-start gap-2">
                    <p className="flex-1 font-semibold leading-tight line-clamp-2">{r.name}</p>
                    <Link href={`/routines/${r.id}`} className="text-muted text-lg leading-none px-1" aria-label="Edit routine">
                      ⋯
                    </Link>
                  </div>
                  <p className="text-xs text-muted mt-1">
                    {r.exercises.length} exercise{r.exercises.length === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-muted mt-0.5 line-clamp-2 flex-1">{muscles.join(", ") || "—"}</p>
                  <button className="btn-primary w-full mt-2 py-2 text-sm" disabled={busy === r.id} onClick={() => start(r.id)}>
                    {busy === r.id ? "Starting…" : "Start"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        )}
        </>
      )}

      <GeneratePlan />
      <SaveFromLink />
    </section>
  );
}
