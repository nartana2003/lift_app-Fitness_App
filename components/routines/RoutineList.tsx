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

/** "My routines" on Home: tap one to start it with your last weights pre-filled. */
export function RoutineList() {
  const router = useRouter();
  const { get } = useCatalogue();
  const routines = useLiveQuery(() => listRoutines(), []);
  const [busy, setBusy] = useState<string | null>(null);

  if (!routines) return null;

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
        <ul className="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4 pb-1">
          {routines.map((r) => {
            const muscles = [...new Set(r.exercises.flatMap((e) => get(e.exercise_id)?.muscle_groups ?? []))];
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

      <GeneratePlan />
      <SaveFromLink />
    </section>
  );
}
