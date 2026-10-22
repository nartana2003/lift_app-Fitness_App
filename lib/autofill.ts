// "Auto-fill from my split" and drag-to-reschedule rules for the weekly planner.
// Pure: no Dexie, so it is tested in node. Types only from client modules.
import type { PlannedDayRow, RoutineRow } from "./offline/db";
import type { Split } from "./splits";

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

type RoutineLike = Pick<RoutineRow, "id" | "name" | "day_label" | "created_at"> & { kind?: RoutineRow["kind"] };

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
 * Routine ids in the order of the user's split. Each split day is matched to a
 * routine by day label or name (exact first, then one name containing the other).
 * Mini routines are never used. With no split, or no day matching any routine,
 * every full routine is used, oldest first.
 */
export function splitRoutineOrder(split: Pick<Split, "days">, routines: readonly RoutineLike[]): string[] {
  const full = routines.filter((r) => r.kind !== "mini").sort((a, b) => a.created_at.localeCompare(b.created_at));
  const order: string[] = [];
  for (const day of split.days) {
    const want = norm(day.name);
    if (!want) continue;
    const hit =
      full.find((r) => norm(r.day_label) === want) ??
      full.find((r) => norm(r.name) === want) ??
      full.find((r) => looseMatch(r.name, day.name));
    if (hit) order.push(hit.id);
  }
  return order.length > 0 ? order : full.map((r) => r.id);
}

/** Whether a day is free to receive a routine (nothing planned, not trained). */
const isFree = (p: Pick<PlannedDayRow, "routine_id" | "status"> | undefined) =>
  !p || (!p.routine_id && p.status !== "done");

/**
 * Lay routines across the chosen gym days of the week, in split order.
 * Only free days from today on are filled; planned, done, skipped and moved
 * days are left alone. Returns the days to plan.
 */
export function autoFillPlan(input: {
  days: readonly string[];
  gymDays: readonly number[];
  plan: ReadonlyMap<string, Pick<PlannedDayRow, "routine_id" | "status">>;
  today: string;
  routineIds: readonly string[];
}): { date: string; routine_id: string }[] {
  const { days, gymDays, plan, today, routineIds } = input;
  if (routineIds.length === 0) return [];
  const gym = new Set(gymDays);
  const out: { date: string; routine_id: string }[] = [];
  for (const date of days) {
    if (date < today || !gym.has(weekdayOf(date)) || !isFree(plan.get(date))) continue;
    out.push({ date, routine_id: routineIds[out.length % routineIds.length] });
  }
  return out;
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
