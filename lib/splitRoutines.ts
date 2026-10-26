// Links between routines and the days of the user's split.
// Pure: no Dexie, so it is tested in node. Types only from client modules.
//
// A split day has a stable `id`; a routine may carry `split_day_id` pointing at
// one. A routine whose day no longer exists (deleted or replaced) simply counts
// as unassigned: routines are never deleted because of a split change.
import type { RoutineRow } from "./offline/db";
import type { Split, SplitDay } from "./splits";

/** The fields of a routine these helpers read. */
export type LinkableRoutine = Pick<RoutineRow, "id" | "created_at"> & {
  kind?: RoutineRow["kind"];
  split_day_id?: string | null;
};

/** routine id -> ISO time of the latest workout done from it. */
export type LastDone = ReadonlyMap<string, string>;

const fallbackId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `day-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const hasId = (d: SplitDay): d is SplitDay & { id: string } => typeof d.id === "string" && d.id.length > 0;

/** Whether every day already has its own id (no missing and no repeated ids). */
export function splitHasDayIds(split: Pick<Split, "days">): boolean {
  const seen = new Set<string>();
  for (const d of split.days) {
    if (!hasId(d) || seen.has(d.id)) return false;
    seen.add(d.id);
  }
  return true;
}

/**
 * The split with an id on every day. Days that already have an id keep it, so a
 * rename, reorder or muscle edit never changes it; only days with no id (or a
 * repeat of an earlier day's id) get a new one. Never mutates the input.
 */
export function withDayIds<S extends Pick<Split, "days">>(split: S, makeId: () => string = fallbackId): S {
  if (splitHasDayIds(split)) return split;
  // First keep every existing id (first use wins), so a new id can never take one.
  const kept = new Set<string>();
  const keep = split.days.map((d) => {
    if (!hasId(d) || kept.has(d.id)) return false;
    kept.add(d.id);
    return true;
  });
  const days = split.days.map((d, i) => {
    if (keep[i]) return d;
    let id = makeId();
    while (!id || kept.has(id)) id = makeId();
    kept.add(id);
    return { ...d, id };
  });
  return { ...split, days };
}

/** Ids of the days in a split (days without an id have none). */
export const splitDayIds = (split: Pick<Split, "days">): Set<string> =>
  new Set(split.days.filter(hasId).map((d) => d.id));

const oldestFirst = <T extends LinkableRoutine>(a: T, b: T) => a.created_at.localeCompare(b.created_at);

/**
 * Routines linked to one split day, oldest first. Full routines only, unless
 * `includeMini` is set (a mini routine can be linked, but is never picked automatically).
 */
export function routinesForDay<T extends LinkableRoutine>(
  routines: readonly T[],
  dayId: string | null | undefined,
  opts: { includeMini?: boolean } = {},
): T[] {
  if (!dayId) return [];
  return routines
    .filter((r) => r.split_day_id === dayId && (opts.includeMini || r.kind !== "mini"))
    .sort(oldestFirst);
}

/**
 * Routines not linked to any day of this split (no link, or a link to a day
 * that was removed), oldest first. Mini routines are included.
 */
export function unassignedRoutines<T extends LinkableRoutine>(routines: readonly T[], split: Pick<Split, "days">): T[] {
  const ids = splitDayIds(split);
  return routines.filter((r) => !r.split_day_id || !ids.has(r.split_day_id)).sort(oldestFirst);
}

/**
 * The routines with one routine linked to `dayId` (or unlinked with null).
 * Pure: returns a new list, other routines are untouched. The stored write is
 * `linkRoutineToDay` in lib/routines.ts.
 */
export function assignRoutine<T extends LinkableRoutine>(
  routines: readonly T[],
  routineId: string,
  dayId: string | null,
): T[] {
  return routines.map((r) => (r.id === routineId ? { ...r, split_day_id: dayId } : r));
}

/**
 * Links to clear because their day is no longer in the split. Returns the
 * routine ids to unlink; the routines themselves are kept (they become unassigned).
 */
export function clearLinksForRemovedDays(split: Pick<Split, "days">, routines: readonly LinkableRoutine[]): string[] {
  const ids = splitDayIds(split);
  return routines.filter((r) => !!r.split_day_id && !ids.has(r.split_day_id)).map((r) => r.id);
}

/**
 * The routine to do next on a split day: of the full routines linked to it, the
 * one done longest ago (never done counts as longest ago); ties go to the oldest
 * routine. Null when the day has no linked full routine.
 */
export function nextRoutineForDay<T extends LinkableRoutine>(
  routines: readonly T[],
  dayId: string | null | undefined,
  lastDone: LastDone = new Map(),
): T | null {
  const linked = routinesForDay(routines, dayId);
  let best: T | null = null;
  let bestAt = "";
  for (const r of linked) {
    const at = lastDone.get(r.id) ?? "";
    // `linked` is oldest first, so a strict "<" keeps the oldest routine on a tie.
    if (best === null || at < bestAt) {
      best = r;
      bestAt = at;
    }
  }
  return best;
}

/** routine id -> latest start time of a workout done from it. */
export function lastDoneByRoutine(
  workouts: readonly { routine_id: string | null; started_at: string }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of workouts) {
    if (!w.routine_id) continue;
    const cur = out.get(w.routine_id);
    if (cur === undefined || w.started_at > cur) out.set(w.routine_id, w.started_at);
  }
  return out;
}
