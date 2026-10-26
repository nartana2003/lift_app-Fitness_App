"use client";

// The weekly plan: which routine is planned for each day, plus skipping and moving days.
import { db, uuid, type OutboxItem, type PlannedDayRow, type SkipReason } from "./offline/db";
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

/**
 * Read one date's row and write its replacement (plus the outbox entry) in a
 * single rw transaction, so overlapping calls on the same date are serialised
 * and never both insert a row (the `&date` index would reject the second).
 * `next` returns null to write nothing. Returns true when a row was written.
 */
async function writeDayAtomic(date: string, next: (cur: PlannedDayRow | undefined) => PlannedDayRow | null): Promise<boolean> {
  const ok = await db.transaction("rw", db.planned_days, db.outbox, async () => {
    const row = next(await getDay(date));
    if (!row) return false;
    await db.planned_days.put(row);
    await db.outbox.add({ table: "planned_days", op: "upsert", row, created_at: new Date().toISOString() });
    return true;
  });
  // Push only after the transaction has committed (flush runs outside it).
  if (ok) void flush();
  return ok;
}

/**
 * True when any day other than `date` has `routineId` on its plan (in any
 * status: planned, done, skipped or moved). Used before changing a routine in
 * place for one day, so the change never leaks into another day's plan.
 */
export async function routineUsedOnOtherDay(routineId: string, date: string): Promise<boolean> {
  const rows = await db.planned_days.toArray();
  return rows.some((r) => r.routine_id === routineId && r.date !== date);
}

/** Plan a routine on a day (replacing whatever was there). */
export async function planDay(date: string, routineId: string) {
  await writeDayAtomic(date, (cur) => ({
    ...(cur ?? blank(date)),
    routine_id: routineId,
    status: "planned",
    skip_reason: null,
    skip_note: null,
    moved_to: null,
  }));
}

/**
 * Mark a date as a gym day with no routine yet (a planned row, routine_id null),
 * through the same save/outbox path as planning. Never changes a date that
 * already has a row. Returns true when a new mark was written. The check and
 * the write are one transaction, so rapid repeated taps write one row only.
 */
export async function markGymDay(date: string): Promise<boolean> {
  return writeDayAtomic(date, (cur) => (cur ? null : blank(date)));
}

/** A routine-less planned row: a date the user marked as a gym day. */
const isMarkedOnly = (row: PlannedDayRow | undefined) => !!row && row.status === "planned" && !row.routine_id;

/**
 * Unmark a gym day: removes a planned date's row (with its routine, if any).
 * Done, skipped and moved dates cannot be unmarked. Returns true when removed.
 */
export async function unmarkGymDay(date: string): Promise<boolean> {
  const cur = await getDay(date);
  if (!cur || cur.status !== "planned") return false;
  await clearDay(date);
  return true;
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
    const existing = await getDay(to);
    const target = existing ?? blank(to);
    const origin: PlannedDayRow = { ...cur, status: "moved", skip_reason: reason, skip_note: note?.trim() || null, moved_to: to };
    const dest: PlannedDayRow = { ...target, routine_id: cur.routine_id, status: "planned", skip_reason: null, skip_note: null, moved_from: from };
    // Remember that the user had marked this date, so undo keeps the mark.
    if (isMarkedOnly(existing)) dest.was_marked = true;
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

/**
 * If `row` is the target of an earlier skip-and-move, point the original day's
 * `moved_to` at `to` instead. Must run inside a planned_days transaction.
 */
async function relink(row: PlannedDayRow, to: string, out: OutboxItem[], at: string) {
  if (!row.moved_from) return;
  const origin = await getDay(row.moved_from);
  if (!origin || origin.moved_to !== row.date) return;
  const next: PlannedDayRow = { ...origin, moved_to: to };
  await db.planned_days.put(next);
  out.push({ table: "planned_days", op: "upsert", row: next, created_at: at });
}

/**
 * Drag-to-reschedule: move a planned day's routine to a free day (no skip reason).
 * Every write and its outbox entries happen in one transaction, so a failure
 * part-way leaves both days as they were. If the dragged day was itself the
 * target of a skip-and-move, the link travels with it (the original day's
 * `moved_to` points at the new day). Returns false when the drop is not valid.
 */
export async function rescheduleDay(from: string, to: string): Promise<boolean> {
  if (from === to) return false;
  const ok = await db.transaction("rw", db.planned_days, db.outbox, async () => {
    const src = await getDay(from);
    if (!src?.routine_id || src.status !== "planned") return false;
    const target = await getDay(to);
    if (target && (target.routine_id || target.status === "done")) return false;
    const at = new Date().toISOString();
    const out: OutboxItem[] = [];
    await relink(src, to, out, at);
    const dest: PlannedDayRow = {
      ...(target ?? blank(to)),
      routine_id: src.routine_id,
      status: "planned",
      skip_reason: null,
      skip_note: null,
      moved_to: null,
      moved_from: src.moved_from,
    };
    // A mark on the drop date survives an undo of the move that now points here.
    if (isMarkedOnly(target)) dest.was_marked = true;
    else delete dest.was_marked;
    await db.planned_days.put(dest);
    out.push({ table: "planned_days", op: "upsert", row: dest, created_at: at });
    await db.planned_days.delete(src.id);
    out.push({ table: "planned_days", op: "delete", row: { id: src.id }, created_at: at });
    await db.outbox.bulkAdd(out);
    return true;
  });
  if (ok) void flush();
  return ok;
}

/**
 * Swap the routines of two planned days, in one transaction. Skip-and-move
 * links travel with the routines: each day takes the other's `moved_from`, and
 * the original days' `moved_to` are pointed at the new dates. Returns false
 * when either day is not a planned day with a routine.
 */
export async function swapDays(a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const ok = await db.transaction("rw", db.planned_days, db.outbox, async () => {
    const ra = await getDay(a);
    const rb = await getDay(b);
    if (!ra?.routine_id || ra.status !== "planned" || !rb?.routine_id || rb.status !== "planned") return false;
    const at = new Date().toISOString();
    const out: OutboxItem[] = [];
    await relink(ra, b, out, at);
    await relink(rb, a, out, at);
    const na: PlannedDayRow = { ...ra, routine_id: rb.routine_id, moved_from: rb.moved_from, skip_reason: null, skip_note: null, moved_to: null };
    const nb: PlannedDayRow = { ...rb, routine_id: ra.routine_id, moved_from: ra.moved_from, skip_reason: null, skip_note: null, moved_to: null };
    await db.planned_days.put(na);
    await db.planned_days.put(nb);
    out.push(
      { table: "planned_days", op: "upsert", row: na, created_at: at },
      { table: "planned_days", op: "upsert", row: nb, created_at: at },
    );
    await db.outbox.bulkAdd(out);
    return true;
  });
  if (ok) void flush();
  return ok;
}

/** Undo a skip or move, putting the day back to planned. */
export async function undoSkip(date: string) {
  const cur = await getDay(date);
  if (!cur) return;
  if (cur.moved_to) {
    const moved = await getDay(cur.moved_to);
    if (moved && moved.moved_from === date) {
      if (moved.status === "done") return; // already trained on the new day; leave it alone
      if (moved.was_marked) {
        // The user had marked that date before the move: put the mark back
        // (a routine-less planned row) rather than deleting it.
        const { was_marked: _drop, ...rest } = moved;
        void _drop;
        await save({ ...rest, routine_id: null, status: "planned", skip_reason: null, skip_note: null, moved_to: null, moved_from: null });
      } else {
        await db.planned_days.delete(moved.id);
        await enqueue([{ table: "planned_days", op: "delete", row: { id: moved.id } }]);
      }
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
