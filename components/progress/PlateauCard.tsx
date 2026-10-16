"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useCatalogue } from "@/lib/catalogue";
import { exerciseSessions, loggedExercises } from "@/lib/history";
import { detectPlateau, type Plateau } from "@/lib/plateau";
import { swapOptions } from "@/lib/swap";
import { useSettings } from "@/lib/settings";
import { fmtWeight } from "@/lib/units";
import { db } from "@/lib/offline/db";

const DISMISS_KEY = "plateau_dismissed";

/** Lifts that have stopped improving, with something to try. */
export function PlateauCard() {
  const { get, exercises } = useCatalogue();
  const { unit } = useSettings();
  const [open, setOpen] = useState<string | null>(null);

  const dismissedRaw = useLiveQuery(async () => ((await db.meta.get(DISMISS_KEY))?.value as string[] | undefined) ?? [], []);
  const dismissed = useMemo<string[]>(() => dismissedRaw ?? [], [dismissedRaw]);

  const plateaus = useLiveQuery(async () => {
    const logged = await loggedExercises();
    const out: Plateau[] = [];
    for (const row of logged.slice(0, 40)) {
      if (row.count < 3) continue;
      const sessions = await exerciseSessions(row.exercise_id, 40);
      const p = detectPlateau(
        row.exercise_id,
        sessions.map((s) => ({ date: s.workout.started_at, sets: s.sets })),
      );
      if (p) out.push(p);
    }
    return out.sort((a, b) => b.weeks - a.weeks);
  }, []);

  const shown = useMemo(() => (plateaus ?? []).filter((p) => !dismissed.includes(p.exerciseId)), [plateaus, dismissed]);

  if (!plateaus || shown.length === 0) return null;

  async function dismiss(id: string) {
    await db.meta.put({ key: DISMISS_KEY, value: [...dismissed, id] });
  }

  return (
    <section className="card p-4">
      <h2 className="text-lg font-bold mb-1">Stalled lifts</h2>
      <p className="text-xs text-muted mb-3">These haven&apos;t improved for a few weeks.</p>
      <ul className="space-y-2">
        {shown.map((p) => {
          const ex = get(p.exerciseId);
          const alts = ex ? swapOptions(exercises, ex, "variety", 3) : [];
          return (
            <li key={p.exerciseId} className="rounded-xl bg-surface-2 p-3">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">{ex?.name ?? p.exerciseId}</p>
                  <p className="text-xs text-muted">
                    {p.weeks} weeks · best {fmtWeight(p.bestE1rm, unit)} est. 1RM · {p.sessions} sessions
                  </p>
                </div>
                <button className="text-xs text-muted shrink-0" onClick={() => dismiss(p.exerciseId)}>
                  Hide
                </button>
              </div>
              <p className="text-sm mt-2">{p.advice}</p>
              <button className="text-xs text-muted underline mt-1" onClick={() => setOpen(open === p.exerciseId ? null : p.exerciseId)}>
                {open === p.exerciseId ? "Hide variations" : "Show variations to try"}
              </button>
              {open === p.exerciseId && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {alts.map((a) => (
                    <Link key={a.id} href={`/exercises/${a.id}`} className="chip text-xs bg-surface">
                      {a.name}
                    </Link>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
