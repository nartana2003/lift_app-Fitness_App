"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useCatalogue } from "@/lib/catalogue";
import { listRoutines, type Routine } from "@/lib/routines";
import { useSplit, type Split } from "@/lib/splits";
import { routinesForDay, splitDayIds, unassignedRoutines } from "@/lib/splitRoutines";
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

/**
 * Start a routine as the live workout, with last weights pre-filled. Asks first
 * when a workout is already in progress. Returns false when the user said no.
 */
export async function startRoutine(r: Pick<Routine, "id" | "name" | "exercises">): Promise<boolean> {
  if (await db.active.get("active")) {
    if (!confirm("You already have a workout in progress. Discard it and start this routine?")) return false;
  }
  await startWorkout({
    name: r.name,
    routineId: r.id,
    exercises: r.exercises.map((e) => ({
      exercise_id: e.exercise_id,
      target_sets: e.target_sets,
      target_reps: e.target_reps,
    })),
  });
  return true;
}

export type RoutineGroup<T> = { dayId: string | null; title: string; routines: T[] };

/**
 * Routines grouped under the split day they belong to (split order), then an
 * Unassigned group last. Days with no routines are left out. Null when nothing
 * is linked to a day of this split: the list is then shown ungrouped, as before.
 * Keeps the input order inside each group.
 */
export function groupRoutinesBySplit<T extends { id: string; created_at: string; kind?: Routine["kind"]; split_day_id?: string | null }>(
  routines: readonly T[],
  split: Pick<Split, "days">,
): RoutineGroup<T>[] | null {
  const ids = splitDayIds(split);
  if (!routines.some((r) => !!r.split_day_id && ids.has(r.split_day_id))) return null;
  const order = new Map(routines.map((r, i) => [r.id, i]));
  const byInput = (a: T, b: T) => order.get(a.id)! - order.get(b.id)!;
  const groups: RoutineGroup<T>[] = [];
  const seen = new Set<string>();
  for (const d of split.days) {
    if (!d.id || seen.has(d.id)) continue;
    seen.add(d.id);
    const list = routinesForDay(routines, d.id, { includeMini: true }).sort(byInput);
    if (list.length) groups.push({ dayId: d.id, title: d.name || "Split day", routines: list });
  }
  const rest = unassignedRoutines(routines, split).sort(byInput);
  if (rest.length) groups.push({ dayId: null, title: "Unassigned", routines: rest });
  return groups;
}

/** "My routines" on Home: tap one to start it with your last weights pre-filled. */
export function RoutineList() {
  const router = useRouter();
  const { get } = useCatalogue();
  const routines = useLiveQuery(() => listRoutines(), []);
  const split = useSplit();
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
      const r = routines!.find((x) => x.id === id)!;
      if (await startRoutine(r)) router.push("/workout");
    } finally {
      setBusy(null);
    }
  }

  // Grouped under split days only when some routine is linked to one; otherwise exactly as before.
  const groups = groupRoutinesBySplit(shown, split);

  const renderRow = (list: typeof shown) => (
    <ul className="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4 pb-1">
      {list.map((r) => {
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
  );

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

      {routines.length === 0 ? null : (
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
        ) : groups === null ? (
          renderRow(shown)
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.dayId ?? "unassigned"} role="group" aria-label={g.title}>
                <h3 className="text-sm font-semibold mb-1.5">{g.title}</h3>
                {renderRow(g.routines)}
              </div>
            ))}
          </div>
        )}
        </>
      )}

      <GeneratePlan />
      <SaveFromLink />
    </section>
  );
}
