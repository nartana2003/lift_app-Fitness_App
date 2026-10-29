"use client";

// "Today's exercises" on Home: the next split day, and for each of its muscles a
// few exercises from the user's starred pool, rotated by how long ago each was
// last done (lib/pool.ts). Picks can be swapped within the muscle's pool or
// unticked, then started as a workout. Rule-based only: no network calls.
//
// LINK-03: when the day has routines linked to it, the card also offers
// "Use my routine: <name>" (the next one by nextRoutineForDay) as an
// alternative. The pool picks stay the default and Start workout still uses them.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Collapsible } from "@/components/Collapsible";
import { useCatalogue } from "@/lib/catalogue";
import { equipmentForAi, useEquipment } from "@/lib/equipment";
import type { Exercise } from "@/lib/exercises";
import { useFavorites } from "@/lib/favorites";
import { allWorkouts } from "@/lib/history";
import type { MuscleGroup } from "@/lib/muscles";
import { db } from "@/lib/offline/db";
import { nextSplitDay, poolByMuscle, suggestToday, type PoolWorkout } from "@/lib/pool";
import { createRoutine, listRoutines } from "@/lib/routines";
import { lastDoneByRoutine, nextRoutineForDay } from "@/lib/splitRoutines";
import { PRESETS, saveSplit, useSplit } from "@/lib/splits";
import { startWorkout } from "@/lib/workout";

/** Dexie meta key for the "how many per muscle" choice (device-local, included in backups). */
export const PER_MUSCLE_KEY = "today_picks_per_muscle";
export const PER_MUSCLE_OPTIONS = [1, 2, 3] as const;
export const DEFAULT_PER_MUSCLE = 2;

/** Stored value to a valid 1..3 count (anything else gives the default). */
export function normalizePerMuscle(raw: unknown): number {
  return typeof raw === "number" && (PER_MUSCLE_OPTIONS as readonly number[]).includes(raw) ? raw : DEFAULT_PER_MUSCLE;
}

export const savePerMuscle = (n: number) => db.meta.put({ key: PER_MUSCLE_KEY, value: normalizePerMuscle(n) });

/** "last done 3 days ago", "last done today", or "not done yet". */
export function lastDoneLabel(days: number | null): string {
  if (days == null) return "not done yet";
  if (days <= 0) return "last done today";
  return `last done ${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Collapsed card subtitle. When the day has muscles but none of them has a
 * single pick (nothing starred for them), hint at starring instead of
 * "0 exercises". Unticking every pick keeps the count wording.
 */
export function picksSubtitle(dayName: string, ticked: number, slotsPerMuscle: readonly number[]): string {
  if (ticked === 0 && slotsPerMuscle.length > 0 && slotsPerMuscle.every((n) => n === 0))
    return `${dayName} · star exercises to get picks`;
  return `${dayName} · ${ticked} exercise${ticked === 1 ? "" : "s"}`;
}

const DAY_MS = 864e5;
const midnight = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Latest finished session time per exercise (working sets only), for swapped-in picks. */
function lastDoneTimes(history: readonly PoolWorkout[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of history) {
    if (!w.ended_at) continue;
    const t = Date.parse(w.started_at);
    if (Number.isNaN(t)) continue;
    for (const x of w.exercises) {
      if (x.sets && !x.sets.some((s) => !s.is_warmup)) continue;
      if ((out.get(x.exercise_id) ?? -Infinity) < t) out.set(x.exercise_id, t);
    }
  }
  return out;
}

type Selection = {
  /** Which day + count the swaps belong to; a change of either starts fresh. */
  key: string;
  /** muscle -> slot index -> swapped-in exercise id. */
  swaps: Partial<Record<MuscleGroup, Record<number, string>>>;
  /** Exercise ids the user unticked. */
  off: string[];
};

const EMPTY: Selection = { key: "", swaps: {}, off: [] };

export function TodayPicks() {
  const router = useRouter();
  const split = useSplit();
  const favourites = useFavorites();
  const equipment = useEquipment();
  const catalogue = useCatalogue();
  const history = useLiveQuery(() => allWorkouts(), []);
  const routines = useLiveQuery(() => listRoutines(), [], []);
  // Wrapped so "still loading" (undefined) differs from "never set" ({ value: undefined }).
  const stored = useLiveQuery(async () => ({ value: (await db.meta.get(PER_MUSCLE_KEY))?.value }), []);
  const perMuscle = normalizePerMuscle(stored?.value);

  const [override, setOverride] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection>(EMPTY);
  const [swapping, setSwapping] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const workouts = history ?? [];
  const next = nextSplitDay(split, workouts, catalogue.exercises, override);

  if (!next) {
    return (
      <Collapsible title="Today's exercises" subtitle="Set up a split to get today's picks">
        <p className="text-sm text-muted">Pick a split and the card suggests exercises from your starred ones for the next day.</p>
        <div className="grid gap-2">
          {PRESETS.map((p) => (
            <button key={p.name} type="button" className="w-full text-left rounded-xl bg-surface-2 p-3 text-sm font-semibold" onClick={() => saveSplit(p)}>
              Use {p.name}
            </button>
          ))}
        </div>
        <Link href="/profile" className="text-sm underline">
          Build your own split in Profile
        </Link>
      </Collapsible>
    );
  }

  // Wait for the catalogue and the history: picks made without history would rotate wrongly.
  if (catalogue.loading || history === undefined || stored === undefined) {
    return (
      <Collapsible title="Today's exercises" subtitle={next.day.name}>
        <p className="text-sm text-muted">Loading…</p>
      </Collapsible>
    );
  }

  const day = next.day;
  const key = `${next.index}|${perMuscle}`;
  const sel = selection.key === key ? selection : { ...EMPTY, key };
  const update = (fn: (s: Selection) => Selection) => {
    setNotice("");
    setSelection(fn(sel));
  };

  const pool = poolByMuscle(favourites, catalogue.exercises, equipmentForAi(equipment));
  const plan = suggestToday({ day, pool, history: workouts, perMuscle, now: Date.now(), catalogue: catalogue.exercises });
  const times = lastDoneTimes(workouts);
  const today = midnight(Date.now());
  const daysAgo = (id: string) => {
    const t = times.get(id);
    return t == null ? null : Math.max(0, Math.round((today - midnight(t)) / DAY_MS));
  };

  // Rows after swaps: each slot is the suggested pick or the user's replacement.
  const rows = plan.muscles.map(({ muscle, picks }) => ({
    muscle,
    slots: picks.map((p, i) => {
      const swappedId = sel.swaps[muscle]?.[i];
      const swapped = swappedId ? pool[muscle].find((e) => e.id === swappedId) : undefined;
      return swapped
        ? { exercise: swapped, lastDoneDaysAgo: daysAgo(swapped.id) }
        : { exercise: p.exercise, lastDoneDaysAgo: p.lastDoneDaysAgo };
    }),
  }));
  const shown = new Set(rows.flatMap((r) => r.slots.map((s) => s.exercise.id)));
  const ticked: Exercise[] = [];
  for (const r of rows)
    for (const s of r.slots)
      if (!sel.off.includes(s.exercise.id) && !ticked.some((e) => e.id === s.exercise.id)) ticked.push(s.exercise);

  const toggle = (id: string) =>
    update((s) => ({ ...s, off: s.off.includes(id) ? s.off.filter((x) => x !== id) : [...s.off, id] }));
  const swap = (muscle: MuscleGroup, slot: number, id: string) => {
    update((s) => ({ ...s, swaps: { ...s.swaps, [muscle]: { ...s.swaps[muscle], [slot]: id } } }));
    setSwapping(null);
  };

  async function start() {
    if (busy || ticked.length === 0) return;
    setBusy(true);
    try {
      if (await db.active.get("active")) {
        if (!confirm("You already have a workout in progress. Discard it and start this one?")) return;
      }
      await startWorkout({ name: day.name, exercises: ticked.map((e) => ({ exercise_id: e.id })) });
      router.push("/workout");
    } finally {
      setBusy(false);
    }
  }

  async function saveRoutine() {
    if (busy || ticked.length === 0) return;
    setBusy(true);
    try {
      await createRoutine({ name: day.name, exercises: ticked.map((e) => ({ exercise_id: e.id })) });
      setNotice(`Saved as routine "${day.name.trim() || "My routine"}".`);
    } finally {
      setBusy(false);
    }
  }

  // LINK-03: the routine linked to this day that was done longest ago, if any.
  const mine = nextRoutineForDay(routines, day.id, lastDoneByRoutine(workouts));

  async function startMine() {
    if (busy || !mine) return;
    setBusy(true);
    try {
      if (await db.active.get("active")) {
        if (!confirm("You already have a workout in progress. Discard it and start this one?")) return;
      }
      await startWorkout({
        name: mine.name,
        routineId: mine.id,
        exercises: mine.exercises.map((e) => ({ exercise_id: e.exercise_id, target_sets: e.target_sets, target_reps: e.target_reps })),
      });
      router.push("/workout");
    } finally {
      setBusy(false);
    }
  }

  const count = ticked.length;
  return (
    <Collapsible title="Today's exercises" subtitle={picksSubtitle(day.name, count, rows.map((r) => r.slots.length))}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[9rem] text-xs text-muted">
          Split day
          <select
            className="field mt-1 py-2 text-sm text-text"
            value={next.index}
            onChange={(e) => {
              setOverride(Number(e.target.value));
              setSwapping(null);
            }}
          >
            {split.days.map((d, i) => (
              <option key={i} value={i}>
                {d.name || `Day ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        <div role="group" aria-label="Exercises per muscle" className="text-xs text-muted">
          Per muscle
          <div className="flex gap-1 mt-1">
            {PER_MUSCLE_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={perMuscle === n}
                aria-label={`${n} per muscle`}
                className={`size-9 rounded-full text-sm font-semibold ${perMuscle === n ? "bg-accent text-accent-ink" : "bg-surface-2 text-text"}`}
                onClick={() => {
                  setSwapping(null);
                  void savePerMuscle(n);
                }}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!next.overridden && <p className="text-xs text-muted">Next in your split.</p>}

      {mine && (
        <div className="rounded-xl border border-border px-3 py-2">
          <p className="text-xs text-muted">Or use the routine you saved for {day.name.trim() || "this day"}.</p>
          <button
            type="button"
            className="mt-1 text-sm font-semibold underline disabled:opacity-40 disabled:no-underline"
            disabled={busy}
            onClick={startMine}
          >
            Use my routine: {mine.name}
          </button>
        </div>
      )}

      {rows.length === 0 && <p className="text-sm text-muted">This day has no muscles yet. Add some in Profile, My split.</p>}

      {rows.map((r) => (
        <div key={r.muscle}>
          <h3 className="text-sm font-semibold">{r.muscle}</h3>
          {r.slots.length === 0 ? (
            <Link href={`/exercises?m=${encodeURIComponent(r.muscle)}`} className="block text-sm underline mt-1">
              Star some exercises for {r.muscle} to build your pool
            </Link>
          ) : (
            <ul className="mt-1 space-y-1">
              {r.slots.map((s, i) => {
                const id = `${r.muscle}:${i}`;
                const alternatives = pool[r.muscle].filter((e) => !shown.has(e.id));
                const on = !sel.off.includes(s.exercise.id);
                return (
                  <li key={id} className="rounded-xl bg-surface-2 px-3 py-2">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--accent)]"
                        checked={on}
                        onChange={() => toggle(s.exercise.id)}
                        aria-label={s.exercise.name}
                      />
                      <div className={`flex-1 min-w-0 ${on ? "" : "opacity-50"}`}>
                        <p className="text-sm font-medium leading-tight">{s.exercise.name}</p>
                        <p className="text-xs text-muted">{lastDoneLabel(s.lastDoneDaysAgo)}</p>
                      </div>
                      <button
                        type="button"
                        className="text-xs font-semibold underline disabled:opacity-40 disabled:no-underline"
                        disabled={alternatives.length === 0}
                        aria-expanded={swapping === id}
                        aria-label={`Swap ${s.exercise.name}`}
                        onClick={() => setSwapping(swapping === id ? null : id)}
                      >
                        Swap
                      </button>
                    </div>
                    {swapping === id && (
                      <ul className="mt-2 space-y-1" aria-label={`Other ${r.muscle} exercises`}>
                        {alternatives.map((e) => (
                          <li key={e.id}>
                            <button
                              type="button"
                              className="w-full text-left rounded-lg bg-surface px-3 py-1.5 text-sm"
                              onClick={() => swap(r.muscle, i, e.id)}
                            >
                              {e.name}
                              <span className="block text-xs text-muted">{lastDoneLabel(daysAgo(e.id))}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}

      <div className="flex gap-2">
        <button type="button" className="btn-primary flex-1 py-3" disabled={busy || count === 0} onClick={start}>
          Start workout
        </button>
        <button
          type="button"
          className="rounded-xl bg-surface-2 px-4 text-sm font-semibold disabled:opacity-40"
          disabled={busy || count === 0}
          onClick={saveRoutine}
        >
          Save as routine
        </button>
      </div>
      <p role="status" aria-live="polite" className="text-xs text-muted empty:hidden">
        {notice}
      </p>
    </Collapsible>
  );
}
