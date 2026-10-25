// "Auto-fill from my split" and drag-to-reschedule rules for the weekly planner.
// Pure: no Dexie, so it is tested in node. Types only from client modules.
import type { PlannedDayRow, RoutineRow } from "./offline/db";
import type { Split } from "./splits";
import { nextRoutineForDay, splitDayIds, type LastDone } from "./splitRoutines";

/** Day of week (0 = Sunday) of a local YYYY-MM-DD key. */
export const weekdayOf = (key: string) => new Date(key + "T00:00:00").getDay();

/** A sensible default set of gym days (0 = Sunday) for a number of sessions a week. */
export function defaultGymDays(sessions: number): number[] {
  const n = Math.max(0, Math.min(7, Math.round(sessions)));
  switch (n) {
    case 0:
    case 3:
      return [1, 3, 5];
    case 1:
      return [1];
    case 2:
      return [1, 4];
    case 4:
      return [1, 2, 4, 5];
    case 5:
      return [1, 2, 3, 4, 5];
    case 6:
      return [1, 2, 3, 4, 5, 6];
    default:
      return [0, 1, 2, 3, 4, 5, 6];
  }
}

type RoutineLike = Pick<RoutineRow, "id" | "name" | "day_label" | "created_at"> & {
  kind?: RoutineRow["kind"];
  split_day_id?: string | null;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Significant words: lower case, no "day", plural "s" dropped ("Leg day" and "Legs" both give {leg}). */
const words = (s: string) =>
  new Set(
    norm(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w && w !== "day" && w !== "days")
      .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)),
  );

/** One name's significant words are all in the other's ("Push" ~ "Push day", but not "Full body A" ~ "Full body B"). */
function looseMatch(a: string, b: string) {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  return [...small].every((w) => big.has(w));
}

/**
 * Routine ids in the order of the user's split. A split day with routines
 * linked to it (RoutineRow.split_day_id) uses the next of them (nextRoutineForDay:
 * the one done longest ago per `lastDone`, ties oldest first). A day with no
 * linked routine is matched by day label or name (exact first, then one name
 * containing the other), skipping routines linked to another day of the split.
 * Mini routines are never used. With no split, or no day matching any routine,
 * every full routine is used, oldest first.
 */
export function splitRoutineOrder(
  split: Pick<Split, "days">,
  routines: readonly RoutineLike[],
  lastDone?: LastDone,
): string[] {
  const full = routines.filter((r) => r.kind !== "mini").sort((a, b) => a.created_at.localeCompare(b.created_at));
  const dayIds = splitDayIds(split);
  // Routines explicitly linked to a day of this split are not up for name matching.
  const free = full.filter((r) => !r.split_day_id || !dayIds.has(r.split_day_id));
  const order: string[] = [];
  for (const day of split.days) {
    const linked = day.id ? nextRoutineForDay(full, day.id, lastDone) : null;
    if (linked) {
      order.push(linked.id);
      continue;
    }
    const want = norm(day.name);
    if (!want) continue;
    const hit =
      free.find((r) => norm(r.day_label) === want) ??
      free.find((r) => norm(r.name) === want) ??
      free.find((r) => looseMatch(r.name, day.name));
    if (hit) order.push(hit.id);
  }
  return order.length > 0 ? order : full.map((r) => r.id);
}

/** Whether a day is free to receive a routine (nothing planned, not trained). */
const isFree = (p: Pick<PlannedDayRow, "routine_id" | "status"> | undefined) =>
  !p || (!p.routine_id && p.status !== "done");

/**
 * Whether a date counts as a gym day on the strip: a planned row (with or
 * without a routine) or a trained day. Skipped and moved dates do not.
 */
export const isGymDay = (p: Pick<PlannedDayRow, "status"> | undefined) =>
  !!p && (p.status === "planned" || p.status === "done");

/** Dates marked as gym days, from today on, that have no routine yet (in date order). */
export function markedOpenDates(
  days: readonly string[],
  plan: ReadonlyMap<string, Pick<PlannedDayRow, "routine_id" | "status">>,
  today: string,
): string[] {
  return days.filter((d) => {
    const p = plan.get(d);
    return d >= today && !!p && !p.routine_id && p.status === "planned";
  });
}

/**
 * Lay routines across the chosen gym days of the week, in split order.
 * Only free days from today on are filled; planned, done, skipped and moved
 * days are left alone. Dates in `marked` (gym days with no routine) are given
 * the first routines of the split, then the other picked days. Returns the
 * days to plan, in date order.
 */
export function autoFillPlan(input: {
  days: readonly string[];
  gymDays: readonly number[];
  plan: ReadonlyMap<string, Pick<PlannedDayRow, "routine_id" | "status">>;
  today: string;
  routineIds: readonly string[];
  marked?: readonly string[];
}): { date: string; routine_id: string }[] {
  const { days, gymDays, plan, today, routineIds } = input;
  if (routineIds.length === 0) return [];
  const gym = new Set(gymDays);
  const marked = new Set(input.marked ?? []);
  const open = days.filter((date) => date >= today && gym.has(weekdayOf(date)) && isFree(plan.get(date)));
  const ordered = [...open.filter((d) => marked.has(d)), ...open.filter((d) => !marked.has(d))];
  const out = ordered.map((date, i) => ({ date, routine_id: routineIds[i % routineIds.length] }));
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** The Auto-fill day picker default: the weekdays of marked dates, else the split's default. */
export function defaultPickedDays(marked: readonly string[], sessions: number): number[] {
  if (marked.length === 0) return defaultGymDays(sessions);
  return [...new Set(marked.map(weekdayOf))];
}

export type DropAction = "move" | "swap" | null;

/**
 * What dropping one day onto another does. A planned (not trained) day can be
 * moved to a free day from today on, or swapped with another planned day when
 * both are from today on. Anything else is not a valid drop.
 */
export function dropAction(
  from: string,
  to: string,
  plan: ReadonlyMap<string, Pick<PlannedDayRow, "routine_id" | "status">>,
  today: string,
): DropAction {
  if (from === to || to < today) return null;
  const src = plan.get(from);
  if (!src?.routine_id || src.status !== "planned") return null;
  const dst = plan.get(to);
  if (isFree(dst)) return "move";
  if (dst?.routine_id && dst.status === "planned" && from >= today) return "swap";
  return null;
}

/** Whether a day can be picked up and dragged. */
export const canDrag = (p: Pick<PlannedDayRow, "routine_id" | "status"> | undefined) =>
  !!p?.routine_id && p.status === "planned";
