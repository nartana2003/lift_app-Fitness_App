"use client";

import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseConfigured } from "@/lib/supabase/configured";
import { classifySyncError, customExerciseFromRemote, isTransientServerError, obsoleteDeadLetters, measurementFromRemote, outboxChildren, splitPlannedDays, plannedDayFromRemote, routineExerciseFromRemote, routineFromRemote, toRemoteRow } from "./remote";
import { db, type OutboxItem, type SetRow, type SyncTable, type WorkoutExerciseRow, type WorkoutRow } from "./db";

import Dexie from "dexie";
import { claimOwner } from "./owner";

/*
 * Sync policy (BLK-02):
 * - Local first: every write lands in Dexie, then the outbox uploads it in order.
 * - Last write wins per row: the most recent upload of an id is what the
 *   server keeps; a pull overwrites local rows only while the outbox is empty.
 * - Deletes: a delete made on this device is queued and sent. A delete made on
 *   another device removes local workouts in the pulled window (pull), but not
 *   planned days, routines, measurements or custom exercises (pullTables is
 *   upsert only; there are no server tombstones).
 * - A row the server rejects for good (see classifySyncError) is moved to the
 *   dead-letter list in meta (DEAD_LETTER_KEY) with its queued children, so it
 *   never blocks the rest of the queue. Network/auth/server errors are retried
 *   (coded ones at most MAX_CODED_RETRIES times per session). The local rows of
 *   a dead letter are kept (pull never deletes them) and the banner shows the
 *   count. The list keeps the newest MAX_DEAD_LETTERS entries. Profile > Sync
 *   (components/SyncCard.tsx) lists them with Resend and Dismiss (BLK-04).
 * - A dead letter is dropped when its row is deleted on this device or a newer
 *   write of the same row is queued (obsoleteDeadLetters): deleting a workout or
 *   routine also drops its children's letters. Transient server errors (5xx,
 *   timeouts) never count towards the coded retry cap.
 * - The device belongs to the first account that syncs it (owner.ts); another
 *   account signed in on the same browser is refused.
 */

const now = () => new Date().toISOString();

/** meta key: outbox items the server rejected permanently (newest last, capped). */
export const DEAD_LETTER_KEY = "outbox:dead";
export const MAX_DEAD_LETTERS = 200;

export type DeadLetter = {
  table: SyncTable;
  op: "upsert" | "delete";
  row: Record<string, unknown>;
  code: string;
  message: string;
  at: string;
  /** Times this item has been dead-lettered (1 on the first rejection). */
  tries?: number;
};

/** A dead letter is re-sent at most this many times in total (retryDeadLetters). */
export const MAX_DEAD_LETTER_TRIES = 5;

/**
 * Queue local writes (already applied to Dexie) for upload. Inside a Dexie
 * transaction that includes db.outbox, the items join it (write + queue commit
 * together) and the upload starts after the transaction.
 */
export async function enqueue(items: Omit<OutboxItem, "created_at" | "seq">[]) {
  await db.outbox.bulkAdd(items.map((i) => ({ ...i, created_at: now() })));
  if (Dexie.currentTransaction) {
    setTimeout(() => void dropDeadLettersFor(items).catch(() => 0), 0);
    setTimeout(() => void flush(), 0);
  } else {
    await dropDeadLettersFor(items).catch(() => 0);
    void flush();
  }
}

/**
 * Write to Dexie and queue the outbox items in ONE transaction, so a pull can
 * never land between the local write and its queue entry. `write` returns the
 * items to queue.
 */
export async function writeAndQueue(
  tables: Dexie.Table[],
  write: () => Promise<Omit<OutboxItem, "created_at" | "seq">[]>,
): Promise<void> {
  const queued = await db.transaction("rw", [...tables, db.outbox], async () => {
    const items = await write();
    if (items.length) await db.outbox.bulkAdd(items.map((i) => ({ ...i, created_at: now() })));
    return items;
  });
  if (!queued.length) return;
  // Called inside an outer transaction: upload only after it (flush must not run in its scope).
  if (Dexie.currentTransaction) {
    setTimeout(() => void dropDeadLettersFor(queued).catch(() => 0), 0);
    setTimeout(() => void flush(), 0);
  } else {
    await dropDeadLettersFor(queued).catch(() => 0);
    void flush();
  }
}

/**
 * Drop dead letters made obsolete by `items` (deletes of the same row or of a
 * parent, newer upserts of the same row). `known` carries local child ids read
 * before the local rows were deleted. Runs in its own transaction on meta, so
 * it must not be awaited inside a transaction that does not include db.meta.
 */
async function dropDeadLettersFor(
  items: readonly { table: SyncTable; op: "upsert" | "delete"; row: Record<string, unknown> }[],
  known: { workoutExerciseIds?: Iterable<string>; setIds?: Iterable<string> } = {},
): Promise<number> {
  if (!items.length) return 0;
  return db.transaction("rw", db.meta, async () => {
    const list = await deadLetters();
    if (!list.length) return 0;
    const gone = obsoleteDeadLetters(list, items, known);
    if (gone.size) await db.meta.put({ key: DEAD_LETTER_KEY, value: list.filter((d) => !gone.has(d)) });
    return gone.size;
  });
}

let flushing: Promise<number> | null = null;
let flushAgain = false;

async function deadLetter(items: OutboxItem[], error: { code?: unknown; message?: unknown }) {
  await db.transaction("rw", db.outbox, db.meta, async () => {
    const cur = (await db.meta.get(DEAD_LETTER_KEY))?.value;
    const list = Array.isArray(cur) ? (cur as DeadLetter[]) : [];
    for (const i of items) {
      list.push({
        table: i.table,
        op: i.op,
        row: i.row,
        code: typeof error.code === "string" ? error.code : "",
        message: typeof error.message === "string" ? error.message.slice(0, 300) : "",
        at: now(),
        tries: (i.retries ?? 0) + 1,
      });
    }
    await db.meta.put({ key: DEAD_LETTER_KEY, value: list.slice(-MAX_DEAD_LETTERS) });
    await db.outbox.bulkDelete(items.map((i) => i.seq!));
  });
}

/**
 * Local workouts with a dead-lettered row (the workout, one of its exercises
 * or sets): the server never got them, so a pull must not delete them.
 */
async function deadLetterWorkoutIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const weIds: string[] = [];
  for (const d of await deadLetters()) {
    if (d.op !== "upsert") continue;
    if (d.table === "workouts" && typeof d.row.id === "string") ids.add(d.row.id);
    if (d.table === "workout_exercises" && typeof d.row.workout_id === "string") ids.add(d.row.workout_id);
    if (d.table === "sets" && typeof d.row.workout_exercise_id === "string") weIds.push(d.row.workout_exercise_id);
  }
  if (weIds.length) for (const we of await db.workout_exercises.bulkGet(weIds)) if (we) ids.add(we.workout_id);
  return ids;
}

/**
 * Re-queue dead letters (in their original order, so parents go before their
 * children). 42703 / PGRST204 / 23503 usually mean the app was deployed before
 * migration 0002 was applied, not that the row is bad, so they are worth
 * another try. An item that has been rejected MAX_DEAD_LETTER_TRIES times stays
 * in the list and is not re-sent. Returns how many were re-queued.
 */
export async function retryDeadLetters(): Promise<number> {
  const n = await db.transaction("rw", db.outbox, db.meta, async () => {
    // A letter superseded by a queued delete (of it or its parent) or a newer
    // upsert of the same row is dropped, never re-sent over the newer write.
    const all = await deadLetters();
    if (!all.length) return 0;
    const gone = obsoleteDeadLetters(all, await db.outbox.toArray());
    const list = all.filter((d) => !gone.has(d));
    const again = list.filter((d) => (d.tries ?? 1) < MAX_DEAD_LETTER_TRIES);
    if (!again.length) {
      if (gone.size) await db.meta.put({ key: DEAD_LETTER_KEY, value: list });
      return 0;
    }
    await db.outbox.bulkAdd(again.map((d) => ({ table: d.table, op: d.op, row: d.row, created_at: now(), retries: d.tries ?? 1 })));
    await db.meta.put({ key: DEAD_LETTER_KEY, value: list.filter((d) => (d.tries ?? 1) >= MAX_DEAD_LETTER_TRIES) });
    return again.length;
  });
  if (n) void flush();
  return n;
}

/** Items the server rejected permanently (kept for support/debugging). */
export async function deadLetters(): Promise<DeadLetter[]> {
  const v = (await db.meta.get(DEAD_LETTER_KEY))?.value;
  return Array.isArray(v) ? (v as DeadLetter[]) : [];
}

/** Stable id of a dead letter for the Profile > Sync list (table, op, row id, time). */
export function deadLetterKey(d: Pick<DeadLetter, "table" | "op" | "row" | "at">): string {
  return [d.table, d.op, String(d.row?.id ?? ""), d.at].join("|");
}

const pick = (list: DeadLetter[], keys?: readonly string[]) => {
  if (!keys) return { chosen: list, rest: [] as DeadLetter[] };
  const want = new Set(keys);
  return { chosen: list.filter((d) => want.has(deadLetterKey(d))), rest: list.filter((d) => !want.has(deadLetterKey(d))) };
};

/**
 * User-initiated re-send (Profile > Sync): queue the chosen dead letters (all
 * when `keys` is omitted) in their original order, even past
 * MAX_DEAD_LETTER_TRIES, and remove them from the list. Letters made obsolete
 * by newer queued writes are dropped instead of sent. Returns how many were queued.
 */
export async function resendDeadLetters(keys?: readonly string[]): Promise<number> {
  const n = await db.transaction("rw", db.outbox, db.meta, async () => {
    const { chosen, rest } = pick(await deadLetters(), keys);
    if (!chosen.length) return 0;
    const gone = obsoleteDeadLetters(chosen, await db.outbox.toArray());
    const send = chosen.filter((d) => !gone.has(d));
    if (send.length) await db.outbox.bulkAdd(send.map((d) => ({ table: d.table, op: d.op, row: d.row, created_at: now(), retries: d.tries ?? 1 })));
    await db.meta.put({ key: DEAD_LETTER_KEY, value: rest });
    return send.length;
  });
  if (n) void flush();
  return n;
}

/**
 * Forget the chosen dead letters (all when `keys` is omitted): they are never
 * re-sent and the banner count drops. The local rows are not touched.
 */
export async function dismissDeadLetters(keys?: readonly string[]): Promise<number> {
  return db.transaction("rw", db.meta, async () => {
    const { chosen, rest } = pick(await deadLetters(), keys);
    if (chosen.length) await db.meta.put({ key: DEAD_LETTER_KEY, value: rest });
    return chosen.length;
  });
}

/**
 * Retry cap for errors that carry a code but are not classed permanent (e.g.
 * 42501 row-level security, PGRST301 expired token): after this many failed
 * passes in one session the item is dead-lettered so it cannot block the queue
 * forever. Errors without a code (network) are retried without limit.
 */
export const MAX_CODED_RETRIES = 20;
const attempts = new Map<number, number>();

/** Workout ids uploaded by flush, with the time, so a pull in flight never deletes them. */
const sentWorkouts = new Map<string, string>();

/** planned_days / workouts pointing at a routine deleted on this device: send no link (FK). */
async function guardForeignKeys(table: SyncTable, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  if ((table === "planned_days" || table === "workouts") && typeof row.routine_id === "string" && row.routine_id) {
    if (!(await db.routines.get(row.routine_id))) return { ...row, routine_id: null };
  }
  return row;
}

async function flushOnce(): Promise<number> {
  if (!supabaseConfigured) return 0;
  if (typeof navigator !== "undefined" && !navigator.onLine) return 0;
  const supabase = supabaseBrowser();
  const { data } = await supabase.auth.getSession();
  if (!data.session) return 0;

  const uid = data.session.user.id;
  if (!(await claimOwner(uid))) return 0;
  let sent = 0;
  for (;;) {
    const item = await db.outbox.orderBy("seq").first();
    if (!item) break;
    const q = supabase.from(item.table);
    // A user's own exercises are rows in the shared `exercises` table, owned by them.
    // toRemoteRow also makes planned_days.was_marked and routines.split_day_id explicit.
    const row = await guardForeignKeys(item.table, toRemoteRow(item.table, item.row, uid));
    const { error, status } =
      item.op === "upsert" ? await q.upsert(row) : await q.delete().eq("id", item.row.id as string);
    if (error) {
      // Transient server errors (5xx, timeouts) are retried like network errors.
      const coded = typeof error.code === "string" && error.code !== "" && !isTransientServerError(error, status);
      const tries = (attempts.get(item.seq!) ?? 0) + 1;
      attempts.set(item.seq!, tries);
      if (classifySyncError(error) === "permanent" || (coded && tries >= MAX_CODED_RETRIES)) {
        console.warn("sync rejected, moved to dead letters", item.table, error.code);
        const children = outboxChildren(item, await db.outbox.orderBy("seq").toArray());
        await deadLetter([item, ...children], error);
        attempts.delete(item.seq!);
        continue;
      }
      console.warn("sync failed, will retry", item.table, error.message);
      break;
    }
    attempts.delete(item.seq!);
    if (item.table === "workouts" && item.op === "upsert" && typeof item.row.id === "string") {
      sentWorkouts.set(item.row.id, now());
      if (sentWorkouts.size > 500) sentWorkouts.delete(sentWorkouts.keys().next().value!);
    }
    await db.outbox.delete(item.seq!);
    // A delete reached the server: its own and its children's dead letters are moot.
    if (item.op === "delete") await dropDeadLettersFor([item]);
    sent++;
  }
  if (sent) window.dispatchEvent(new CustomEvent("lift:synced", { detail: sent }));
  return sent;
}

/**
 * Push the outbox in order. Upserts use client-generated UUIDs, so re-sending
 * after a dropped connection never creates duplicates. Never rejects. An
 * enqueue during a pass starts one more pass afterwards.
 */
export function flush(): Promise<number> {
  if (flushing) {
    flushAgain = true;
    return flushing;
  }
  flushAgain = false;
  flushing = flushOnce()
    .catch((e: unknown) => {
      console.warn("sync pass failed, will retry", e instanceof Error ? e.message : "");
      return 0;
    })
    .finally(() => {
      flushing = null;
      if (flushAgain) {
        flushAgain = false;
        setTimeout(() => void flush(), 0);
      }
    });
  return flushing;
}

export async function pendingCount() {
  return db.outbox.count();
}

/** Pull the user's recent history from Supabase into the local store. */
export async function pull(days = 365) {
  if (!supabaseConfigured || !navigator.onLine) return;
  await flush(); // never overwrite unsent local edits
  if ((await db.outbox.count()) > 0) return;

  const supabase = supabaseBrowser();
  const { data: auth } = await supabase.auth.getSession();
  const uid = auth.session?.user.id;
  if (!uid || !(await claimOwner(uid))) return;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  // Workouts started after this moment cannot be in the response: never delete them.
  const fetchStart = now();
  const { data, error } = await supabase
    .from("workouts")
    .select("id, started_at, ended_at, notes, routine_id, workout_exercises(id, workout_id, exercise_id, position, sets(id, workout_exercise_id, set_no, reps, weight, is_warmup, rir, completed_at))")
    .gte("started_at", since)
    .order("started_at", { ascending: false });
  if (error || !data) return;

  type Pulled = WorkoutRow & { workout_exercises: (WorkoutExerciseRow & { sets: SetRow[] })[] };
  const ws: WorkoutRow[] = [];
  const wes: WorkoutExerciseRow[] = [];
  const ss: SetRow[] = [];
  for (const w of data as Pulled[]) {
    const { workout_exercises, ...wr } = w;
    ws.push(wr);
    for (const we of workout_exercises) {
      const { sets, ...wer } = we;
      wes.push(wer);
      ss.push(...sets.map((s) => ({ ...s, weight: Number(s.weight) })));
    }
  }
  const applied = await db.transaction("rw", [db.workouts, db.workout_exercises, db.sets, db.outbox, db.meta], async () => {
    // Re-check inside the transaction: a workout may have been saved and queued
    // while the request was in flight. Any queued item means local is ahead.
    if ((await db.outbox.count()) > 0) return false;
    const local = await db.workouts.where("started_at").aboveOrEqual(since).toArray();
    const remote = new Set(ws.map((w) => w.id));
    // Never delete: workouts the server rejected (dead letters: the only copy is
    // here), and workouts finished or uploaded while the request was in flight.
    const keep = await deadLetterWorkoutIds();
    const sentDuringFetch = (id: string) => (sentWorkouts.get(id) ?? "") >= fetchStart;
    const removed = local
      .filter((w) => !remote.has(w.id) && !keep.has(w.id) && !sentDuringFetch(w.id) && (w.ended_at ?? w.started_at) <= fetchStart)
      .map((w) => w.id);
    if (removed.length) await deleteWorkoutsLocal(removed);
    await db.workouts.bulkPut(ws);
    await db.workout_exercises.bulkPut(wes);
    await db.sets.bulkPut(ss);
    return true;
  });
  if (!applied) return;
  await db.meta.put({ key: "lastPull", value: now() });
  await pullTables();
}

type Client = ReturnType<typeof supabaseBrowser>;

async function selectAll(supabase: Client, table: string, columns: string, filter?: (q: ReturnType<ReturnType<Client["from"]>["select"]>) => unknown) {
  const base = supabase.from(table).select(columns);
  const q = (filter ? filter(base) : base) as PromiseLike<{ data: unknown; error: unknown }>;
  const { data, error } = await q;
  return !error && Array.isArray(data) ? (data as Record<string, unknown>[]) : null;
}

const clean = <T>(rows: Record<string, unknown>[] | null, map: (r: Record<string, unknown>) => T | null): T[] | null =>
  rows ? rows.map(map).filter((x): x is T => x !== null) : null;

/**
 * Sync across devices for the rest of the local store: the user's planned days,
 * routines (+ their exercises), measurements and custom exercises.
 *
 * Upsert only: rows on the server are written locally, local rows are never
 * deleted here (a delete made on another device does not remove a row on this
 * one; last write wins, no tombstones). Runs only with an empty outbox, so it
 * never overwrites unsent edits.
 * A table that fails to load is skipped, the others still apply.
 */
export async function pullTables(): Promise<void> {
  if (!supabaseConfigured || !navigator.onLine) return;
  if ((await db.outbox.count()) > 0) return;
  const supabase = supabaseBrowser();
  const { data: auth } = await supabase.auth.getSession();
  const uid = auth.session?.user.id;
  if (!uid || !(await claimOwner(uid))) return;

  const [planned, routines, routineExercises, measurements, custom] = await Promise.all([
    selectAll(supabase, "planned_days", "id, date, routine_id, status, workout_id, skip_reason, skip_note, moved_to, moved_from, was_marked, created_at"),
    selectAll(supabase, "routines", "id, name, day_label, source, kind, source_url, platform, thumbnail_url, creator, notes, created_at, split_day_id"),
    selectAll(supabase, "routine_exercises", "id, routine_id, exercise_id, position, target_sets, target_reps"),
    selectAll(supabase, "measurements", "id, type, value, date"),
    selectAll(supabase, "exercises", "id, name, muscle_groups, secondary_groups, equipment, category, mechanic, force, level, instructions, image_urls, tiktok_url, video_url", (q) =>
      q.eq("owner_id", uid),
    ),
  ]);

  const days = clean(planned, plannedDayFromRemote);
  const rs = clean(routines, routineFromRemote);
  const res = clean(routineExercises, routineExerciseFromRemote);
  const ms = clean(measurements, measurementFromRemote);
  const cs = clean(custom, customExerciseFromRemote);

  const queuedLoserDeletes = await db.transaction("rw", [db.planned_days, db.routines, db.routine_exercises, db.measurements, db.custom_exercises, db.outbox], async () => {
    // Re-check inside the transaction: a write may have been queued meanwhile.
    // Local writes and their queue entries commit together (writeAndQueue), so
    // an empty outbox here means no local edit is newer than the server.
    if ((await db.outbox.count()) > 0) return false;
    let queued = false;
    if (days) {
      const { keep: unique, losers, relinked } = splitPlannedDays(days);
      // Two devices marked the same date: delete the losing rows on the server
      // too. A winner that took over a loser's workout link is uploaded again.
      if (losers.length) {
        await db.outbox.bulkAdd([
          ...relinked.map((r) => ({ table: "planned_days" as const, op: "upsert" as const, row: { ...r } as Record<string, unknown>, created_at: now() })),
          ...losers.map((l) => ({ table: "planned_days" as const, op: "delete" as const, row: { id: l.id }, created_at: now() })),
        ]);
        queued = true;
      }
      // planned_days has a unique local `date`. Clear every local row that sits on
      // an incoming date or has an incoming id first, then write: rows that swap
      // dates between devices (A 27th->28th, B 28th->27th) can never collide.
      const clash = await db.planned_days.where("date").anyOf(unique.map((d) => d.date)).primaryKeys();
      await db.planned_days.bulkDelete([...new Set([...(clash as string[]), ...unique.map((d) => d.id)])]);
      await db.planned_days.bulkPut(unique);
    }
    if (rs) await db.routines.bulkPut(rs);
    if (res) await db.routine_exercises.bulkPut(res);
    if (ms) {
      // One entry per type per day locally: the server row replaces a local one with another id.
      for (const m of ms) {
        const same = await db.measurements.where("[type+date]").equals([m.type, m.date]).toArray();
        await db.measurements.bulkDelete(same.filter((x) => x.id !== m.id).map((x) => x.id));
      }
      await db.measurements.bulkPut(ms);
    }
    if (cs) await db.custom_exercises.bulkPut(cs);
    return queued;
  });
  if (queuedLoserDeletes) void flush();
}

async function deleteWorkoutsLocal(ids: string[]) {
  const wes = await db.workout_exercises.where("workout_id").anyOf(ids).toArray();
  await db.sets.where("workout_exercise_id").anyOf(wes.map((w) => w.id)).delete();
  await db.workout_exercises.bulkDelete(wes.map((w) => w.id));
  await db.workouts.bulkDelete(ids);
}

/** Delete a workout locally and remotely (cascade on the server). */
export async function deleteWorkout(id: string) {
  // Local child ids, read first, so dead letters of exercises and sets that
  // synced fine (or of their records) are dropped with the workout.
  const knownWes = (await db.workout_exercises.where("workout_id").equals(id).toArray()).map((w) => w.id);
  const knownSets = (await db.sets.where("workout_exercise_id").anyOf(knownWes).primaryKeys()) as string[];
  // Local delete, outbox purge and the queued delete commit together.
  await db.transaction("rw", [db.workouts, db.workout_exercises, db.sets, db.outbox], async () => {
    await deleteWorkoutsLocal([id]);
    // Drop any queued uploads for it, then queue the delete.
    const wes = new Set<string>();
    for (const item of await db.outbox.toArray()) {
      if (item.table === "workout_exercises" && item.row.workout_id === id) wes.add(item.row.id as string);
    }
    await db.outbox
      .filter(
        (i) =>
          (i.table === "workouts" && i.row.id === id) ||
          (i.table === "workout_exercises" && i.row.workout_id === id) ||
          (i.table === "sets" && wes.has(i.row.workout_exercise_id as string)),
      )
      .delete();
    await enqueue([{ table: "workouts" as SyncTable, op: "delete", row: { id } }]);
  });
  await dropDeadLettersFor([{ table: "workouts", op: "delete", row: { id } }], { workoutExerciseIds: knownWes, setIds: knownSets }).catch(() => 0);
}

/** Start background syncing: on load, when connectivity returns, and periodically. */
export function startSync() {
  // Once per app start: give rejected items another chance (e.g. after 0002 was applied).
  void retryDeadLetters()
    .catch(() => 0)
    .then(() => pull())
    .catch(() => {});
  const online = () => void flush().then(() => pull()).catch(() => {});
  window.addEventListener("online", online);
  const t = setInterval(() => void flush(), 30_000);
  return () => {
    clearInterval(t);
    window.removeEventListener("online", online);
  };
}
