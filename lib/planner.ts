"use client";

// The weekly plan: which routine is planned for each day, plus skipping and moving days.
import { db, uuid, type PlannedDayRow, type SkipReason } from "./offline/db";
import { enqueue, flush } from "./offline/sync";
import { addDays, startOfWeek } from "./stats";

export const SKIP_REASONS: { v: SkipReason; label: string }[] = [
  { v: "busy", label: "Busy / work" },
  { v: "tired", label: "Tired" },
  { v: "sore", label: "Sore" },
  { v: "sick", label: "Sick" },
  { v: "injury", label: "Injury" },
  { v: "travel", label: "Travel" },
  { v: "rest", label: "Needed rest" },
  { v: "other", label: "Other" },
];

export const SKIP_LABEL = Object.fromEntries(SKIP_REASONS.map((r) => [r.v, r.label])) as Record<SkipReason, string>;

/** Local YYYY-MM-DD (not UTC, so "today" matches the user's calendar). */
export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const weekDays = (weekStart: 0 | 1, now = new Date()): Date[] => {
  const from = startOfWeek(now, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(from, i));
};

const save = async (row: PlannedDayRow) => {
  await db.planned_days.put(row);
  await enqueue([{ table: "planned_days", op: "upsert", row }]);
};

const blank = (date: string): PlannedDayRow => ({
  id: uuid(),
  date,
  routine_id: null,
  status: "planned",
  workout_id: null,
  skip_reason: null,
  skip_note: null,
  moved_to: null,
  moved_from: null,
  created_at: new Date().toISOString(),
});

export const getDay = (date: string) => db.planned_days.where("date").equals(date).first();

/** Plan a routine on a day (replacing whatever was there). */
export async function planDay(date: string, routineId: string) {
  const cur = await getDay(date);
  await save({ ...(cur ?? blank(date)), routine_id: routineId, status: "planned", skip_reason: null, skip_note: null, moved_to: null });
}

export async function clearDay(date: string) {
  const cur = await getDay(date);
  if (!cur) return;
  await db.planned_days.delete(cur.id);
  await enqueue([{ table: "planned_days", op: "delete", row: { id: cur.id } }]);
}

/** Skip a planned day, with a reason. */
export async function skipDay(date: string, reason: SkipReason, note?: string) {
  const cur = (await getDay(date)) ?? blank(date);
  await save({ ...cur, status: "skipped", skip_reason: reason, skip_note: note?.trim() || null, moved_to: null });
}

/**
 * Move a day's routine to another date, keeping the reason on the original.
 * The original day shows "skipped → moved to Thu".
 */
export async function moveDay(from: string, to: string, reason: SkipReason, note?: string) {
  // Both days and their outbox entries are written in one transaction, so a
  // failure part-way leaves neither day changed (no half-finished move).
  await db.transaction("rw", db.planned_days, db.outbox, async () => {
    const cur = (await getDay(from)) ?? blank(from);
    const target = (await getDay(to)) ?? blank(to);
    const origin: PlannedDayRow = { ...cur, status: "moved", skip_reason: reason, skip_note: note?.trim() || null, moved_to: to };
    const dest: PlannedDayRow = { ...target, routine_id: cur.routine_id, status: "planned", skip_reason: null, skip_note: null, moved_from: from };
    await db.planned_days.put(origin);
    await db.planned_days.put(dest);
    const at = new Date().toISOString();
    await db.outbox.bulkAdd([
      { table: "planned_days", op: "upsert", row: origin, created_at: at },
      { table: "planned_days", op: "upsert", row: dest, created_at: at },
    ]);
  });
  // Push only after the transaction has committed (flush runs outside it).
  void flush();
}

/** Undo a skip or move, putting the day back to planned. */
export async function undoSkip(date: string) {
  const cur = await getDay(date);
  if (!cur) return;
  if (cur.moved_to) {
    const moved = await getDay(cur.moved_to);
    if (moved && moved.moved_from === date) {
      if (moved.status === "done") return; // already trained on the new day; leave it alone
      await db.planned_days.delete(moved.id);
      await enqueue([{ table: "planned_days", op: "delete", row: { id: moved.id } }]);
    }
  }
  await save({ ...cur, status: "planned", skip_reason: null, skip_note: null, moved_to: null });
}

/** Mark the day done when a workout is finished. */
export async function markDone(date: string, workoutId: string) {
  const cur = await getDay(date);
  if (!cur) return;
  await save({ ...cur, status: "done", workout_id: workoutId });
}

/** The days you could move a workout to: free days later this week, soonest first. */
export function moveOptions(days: Date[], plan: Map<string, PlannedDayRow>, from: string, now = new Date()): Date[] {
  const today = dayKey(now);
  return days.filter((d) => {
    const k = dayKey(d);
    if (k === from || k < today) return false;
    const p = plan.get(k);
    return !p || (!p.routine_id && p.status !== "done");
  });
}
