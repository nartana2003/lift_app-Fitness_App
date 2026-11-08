"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useCatalogue } from "@/lib/catalogue";
import { listRoutines, type Routine } from "@/lib/routines";
import { useSplit, type Split } from "@/lib/splits";
import { routinesForDay, splitDayIds, unassignedRoutines } from "@/lib/splitRoutines";
import { startWorkout } from "@/lib/workout";
import { db } from "@/lib/offline/db";
import { MUSCLE_GROUPS, type MuscleGroup } from "@/lib/muscles";
import { FAVORITES, MuscleTab, shortName } from "../ExerciseBrowser";
import { useFavorites } from "@/lib/favorites";
import { MuscleIcon } from "../MuscleIcon";
import { RoutineMenu } from "./RoutineMenu";
import {
  MiniWorkoutCard,
  MuscleCapsules,
  NO_FILTER,
  StartArrow,
  filterRoutines,
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

/** "My routines" on the Exercises tab (Routines view): tap one to start it with your last weights pre-filled. */
export function RoutineList() {
  const router = useRouter();
  const { get } = useCatalogue();
  const routines = useLiveQuery(() => listRoutines(), []);
  const split = useSplit();
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<RoutineFilter>(NO_FILTER);
  const [query, setQuery] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const favorites = useFavorites();

  if (!routines) return null;

  const musclesOf = (r: (typeof routines)[number]) => [
    ...new Set(r.exercises.flatMap((e) => get(e.exercise_id)?.muscle_groups ?? [])),
  ];
  const platformChips = platformsIn(routines);
  // Same muscle row as the Exercises view, so every group is there to filter by.
  const muscleChips: string[] = [...MUSCLE_GROUPS];
  // A chosen chip that no longer exists (its routines were deleted) stops filtering.
  const active: RoutineFilter = {
    platform: filter.platform !== null && platformChips.includes(filter.platform) ? filter.platform : null,
    muscle: filter.muscle !== null && muscleChips.includes(filter.muscle) ? filter.muscle : null,
  };
  const needle = query.trim().toLowerCase();
  const filtering = active.platform !== null || active.muscle !== null || needle !== "" || favOnly;
  const shown = filterRoutines(routines, active, musclesOf).filter((r) => r.name.toLowerCase().includes(needle))
    .filter((r) => !favOnly || favorites.includes(r.id));
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
    <ul className="space-y-3">
      {list.map((r) => {
        const muscles = musclesOf(r);
        if (r.kind === "mini") {
          return (
            <li key={r.id}>
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
          <li key={r.id}>
            <div className="card h-full p-3 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-start gap-2">
                  <p className="flex-1 font-semibold leading-tight line-clamp-2">{r.name}</p>
                  <RoutineMenu id={r.id} name={r.name} />
                </div>
                <p className="text-xs text-muted mt-1">
                  {r.exercises.length} exercise{r.exercises.length === 1 ? "" : "s"}
                </p>
                <MuscleCapsules muscles={muscles} />
              </div>
              <StartArrow busy={busy === r.id} onClick={() => start(r.id)} />
            </div>
          </li>
        );
      })}
    </ul>
  );

  return (
    <section>
      {routines.length === 0 ? null : (
        <>
        <div className="relative mb-2">
          <input
            type="search"
            className="field rounded-full pl-4 pr-10 py-3"
            placeholder="Search routines"
            aria-label="Search routines"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <svg viewBox="0 0 24 24" className="size-5 absolute right-4 top-1/2 -translate-y-1/2 text-muted pointer-events-none" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
          </svg>
        </div>
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
              <div role="group" aria-label="Filter by muscle" className="flex gap-1 overflow-x-auto no-scrollbar -mx-4 pl-4 pr-2 snap-x">
                <MuscleTab label={FAVORITES} active={favOnly} onClick={() => setFavOnly((v) => !v)}>
                  <svg viewBox="0 0 24 24" className="size-7" fill={favOnly ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8}>
                    <path d="M6 3h12v18l-6-4-6 4z" strokeLinejoin="round" />
                  </svg>
                </MuscleTab>
                {muscleChips.map((m) => (
                  <MuscleTab key={m} label={shortName(m)} active={active.muscle === m} onClick={() => pickMuscle(m)}>
                    <MuscleIcon muscle={m as MuscleGroup} className="h-16" />
                  </MuscleTab>
                ))}
              </div>
            )}
          </div>
        )}
        {filtering && shown.length === 0 ? (
          <div className="card p-4 text-sm text-muted flex items-center justify-between gap-2">
            <p>No routines match these filters.</p>
            <button
              type="button"
              className="text-text font-semibold underline shrink-0"
              onClick={() => {
                setFilter(NO_FILTER);
                setQuery("");
                setFavOnly(false);
              }}
            >
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

    </section>
  );
}
