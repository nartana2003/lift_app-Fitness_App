"use client";

// Applies accepted Coach changes (lib/coachOptimise.ts) to the saved split and its
// routines, and undoes the last apply. Past workouts are never touched: they are
// copies of what was done, not links to a routine.
import { db } from "./offline/db";
import { getRoutine, updateRoutine, type RoutineExerciseInput } from "./routines";
import { clearSplit, saveSplit, type Split } from "./splits";
import type { Change } from "./coachOptimise";

/** meta key: the plan as it was before the last apply (one step of undo). */
export const UNDO_KEY = "split_undo";

type UndoSnapshot = {
  at: string;
  split: Split | null;
  routines: { id: string; exercises: RoutineExerciseInput[] }[];
};

export type ApplyResult = {
  /** Ids of the changes that were applied. */
  applied: string[];
  /** Ids of the changes that no longer fit (the day, routine or exercise changed since). */
  skipped: string[];
};

const TABLES = () => [db.meta, db.routines, db.routine_exercises, db.outbox];

/**
 * Writes the accepted changes in one transaction. A change that no longer fits is
 * skipped, never forced. When anything is applied the previous split and the
 * touched routines are saved first so undoOptimise() can restore them, and
 * `opts.builtFor` (the goals fingerprint) is stamped on the split.
 */
export async function applyChanges(changes: readonly Change[], opts: { builtFor?: string } = {}): Promise<ApplyResult> {
  return db.transaction("rw", TABLES(), async () => {
    const applied: string[] = [];
    const skipped: string[] = [];
    const stored = (await db.meta.get("split"))?.value as Split | undefined;
    const days = stored ? stored.days.map((d) => ({ ...d, muscles: [...d.muscles] })) : [];

    // Routines this batch touches, with their exercises before the change.
    const before = new Map<string, RoutineExerciseInput[]>();
    const after = new Map<string, RoutineExerciseInput[]>();
    let splitChanged = false;

    for (const c of changes) {
      if (c.kind === "add_muscle") {
        const day = days.find((d) => d.id === c.dayId);
        if (!day || day.muscles.includes(c.muscle)) skipped.push(c.id);
        else {
          day.muscles.push(c.muscle);
          splitChanged = true;
          applied.push(c.id);
        }
        continue;
      }
      if (!c.routineId || !c.exerciseId) {
        skipped.push(c.id);
        continue;
      }
      if (!after.has(c.routineId)) {
        const r = await getRoutine(c.routineId);
        if (!r) {
          skipped.push(c.id);
          continue;
        }
        const rows = r.exercises.map((e) => ({ exercise_id: e.exercise_id, target_sets: e.target_sets, target_reps: e.target_reps }));
        before.set(c.routineId, rows.map((x) => ({ ...x })));
        after.set(c.routineId, rows);
      }
      const list = after.get(c.routineId)!;
      const at = list.findIndex((x) => x.exercise_id === (c.kind === "swap_exercise" ? c.replaceExerciseId : c.exerciseId));
      if (c.kind === "add_exercise") {
        if (list.some((x) => x.exercise_id === c.exerciseId)) skipped.push(c.id);
        else {
          list.push({ exercise_id: c.exerciseId, target_sets: c.sets ?? undefined, target_reps: c.reps ?? undefined });
          applied.push(c.id);
        }
      } else if (c.kind === "swap_exercise") {
        if (at < 0 || list.some((x) => x.exercise_id === c.exerciseId)) skipped.push(c.id);
        else {
          list[at] = { ...list[at], exercise_id: c.exerciseId };
          applied.push(c.id);
        }
      } else if (at < 0 || (c.sets ?? 0) <= (list[at].target_sets ?? 0)) {
        skipped.push(c.id);
      } else {
        list[at] = { ...list[at], target_sets: c.sets ?? undefined };
        applied.push(c.id);
      }
    }

    if (applied.length === 0) return { applied, skipped };

    const touched = [...after.keys()].filter((id) => JSON.stringify(after.get(id)) !== JSON.stringify(before.get(id)));
    const snapshot: UndoSnapshot = {
      at: new Date().toISOString(),
      split: stored ?? null,
      routines: touched.map((id) => ({ id, exercises: before.get(id)! })),
    };
    await db.meta.put({ key: UNDO_KEY, value: snapshot });
    for (const id of touched) await updateRoutine(id, { exercises: after.get(id)! });
    if (stored && (splitChanged || opts.builtFor)) {
      await saveSplit({ ...stored, days, ...(opts.builtFor ? { builtFor: opts.builtFor } : {}) });
    }
    return { applied, skipped };
  });
}

/** Whether there is an apply to undo. */
export async function hasOptimiseUndo(): Promise<boolean> {
  return !!(await db.meta.get(UNDO_KEY))?.value;
}

/**
 * Puts the split and routines back as they were before the last apply, then drops
 * the snapshot. A routine deleted since is skipped. Returns false when there is
 * nothing to undo. Edits made to those routines after the apply are overwritten.
 */
export async function undoOptimise(): Promise<boolean> {
  return db.transaction("rw", TABLES(), async () => {
    const snap = (await db.meta.get(UNDO_KEY))?.value as UndoSnapshot | undefined;
    if (!snap) return false;
    for (const r of snap.routines) if (await db.routines.get(r.id)) await updateRoutine(r.id, { exercises: r.exercises });
    if (snap.split) await saveSplit(snap.split);
    else await clearSplit();
    await db.meta.delete(UNDO_KEY);
    return true;
  });
}
