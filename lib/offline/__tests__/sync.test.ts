import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Offline outbox idempotency (PLAN.md:250-255). No network: Supabase is replaced
// by an in-memory fake that behaves like a table keyed on `id` (upsert = put).

type Row = Record<string, unknown>;
type Call = { table: string; op: "upsert" | "delete"; id: string };

const server = vi.hoisted(() => {
  const state = {
    tables: new Map<string, Map<string, Record<string, unknown>>>(),
    calls: [] as { table: string; op: "upsert" | "delete"; id: string }[],
    /** Fail the request for these row ids once, before applying it (request never arrived). */
    rejectOnce: new Set<string>(),
    /** Apply the write but report an error once (the response was lost). */
    lostAckOnce: new Set<string>(),
    session: true as boolean,
  };
  const table = (name: string) => {
    if (!state.tables.has(name)) state.tables.set(name, new Map());
    return state.tables.get(name)!;
  };
  const outcome = (id: string, apply: () => void) => {
    if (state.rejectOnce.delete(id)) return { error: { message: "network down" } };
    apply();
    if (state.lostAckOnce.delete(id)) return { error: { message: "response lost" } };
    return { error: null };
  };
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: state.session ? { user: { id: "user-1" } } : null },
      }),
    },
    from: (name: string) => ({
      upsert: async (row: Record<string, unknown>) => {
        const id = row.id as string;
        state.calls.push({ table: name, op: "upsert", id });
        return outcome(id, () => table(name).set(id, { ...row }));
      },
      delete: () => ({
        eq: async (_col: string, id: string) => {
          state.calls.push({ table: name, op: "delete", id });
          return outcome(id, () => table(name).delete(id));
        },
      }),
    }),
  };
  return { state, table, client };
});

vi.mock("@/lib/supabase/configured", () => ({ supabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: () => server.client }));

// sync.ts reads navigator.onLine and dispatches a window event after a send.
const net = { onLine: false };
const win = new EventTarget();
vi.stubGlobal("navigator", net);
vi.stubGlobal("window", win);

const { db } = await import("../db");
const { enqueue, flush, pendingCount, deleteWorkout } = await import("../sync");
const { addExercises, finishWorkout, getActive, startWorkout, toggleSetDone, updateSet } = await import(
  "../../workout"
);

afterAll(() => {
  vi.unstubAllGlobals();
});

/** Let any flush started by enqueue() settle (it short-circuits while offline). */
const idle = () => new Promise((r) => setTimeout(r, 0));

const workout = (id: string, notes: string | null = null) => ({
  table: "workouts" as const,
  op: "upsert" as const,
  row: { id, started_at: "2026-10-01T10:00:00.000Z", ended_at: "2026-10-01T11:00:00.000Z", notes, routine_id: null },
});
const set = (id: string, weId: string, set_no: number, weight: number) => ({
  table: "sets" as const,
  op: "upsert" as const,
  row: { id, workout_exercise_id: weId, set_no, reps: 10, weight, is_warmup: false, rir: null, completed_at: "2026-10-01T10:30:00.000Z" },
});

/** Queue entries while offline so nothing is sent until the test says so. */
async function queueOffline(items: Parameters<typeof enqueue>[0]) {
  net.onLine = false;
  await enqueue(items);
  await idle();
}

async function goOnlineAndFlush() {
  net.onLine = true;
  return flush();
}

const rows = (t: string) => [...server.table(t).values()] as Row[];
const ids = (calls: Call[]) => calls.map((c) => c.id);

beforeEach(async () => {
  await idle();
  await Promise.all(db.tables.map((t) => t.clear()));
  server.state.tables.clear();
  server.state.calls.length = 0;
  server.state.rejectOnce.clear();
  server.state.lostAckOnce.clear();
  server.state.session = true;
  net.onLine = false;
});

describe("outbox flush", () => {
  it("sends queued entries in the order they were queued and empties the outbox", async () => {
    await queueOffline([workout("w1"), set("s1", "we1", 1, 60), set("s2", "we1", 2, 62.5)]);
    await queueOffline([set("s3", "we1", 3, 65)]);
    expect(await pendingCount()).toBe(4);

    expect(await goOnlineAndFlush()).toBe(4);
    expect(ids(server.state.calls)).toEqual(["w1", "s1", "s2", "s3"]);
    expect(await pendingCount()).toBe(0);
    expect(rows("sets").map((r) => r.weight)).toEqual([60, 62.5, 65]);
  });

  it("sends nothing while offline and keeps the queue intact", async () => {
    await queueOffline([workout("w1"), set("s1", "we1", 1, 60)]);
    expect(await flush()).toBe(0);
    expect(server.state.calls).toEqual([]);
    expect(await pendingCount()).toBe(2);
  });

  it("sends nothing without a session and keeps the queue intact", async () => {
    server.state.session = false;
    await queueOffline([workout("w1")]);
    expect(await goOnlineAndFlush()).toBe(0);
    expect(server.state.calls).toEqual([]);
    expect(await pendingCount()).toBe(1);
  });

  it("announces how many entries were synced", async () => {
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    win.addEventListener("lift:synced", on);
    await queueOffline([workout("w1"), set("s1", "we1", 1, 60)]);
    await goOnlineAndFlush();
    win.removeEventListener("lift:synced", on);
    expect(seen).toEqual([2]);
  });

  it("concurrent flushes share one pass, so no entry is sent twice", async () => {
    await queueOffline([workout("w1"), set("s1", "we1", 1, 60), set("s2", "we1", 2, 60)]);
    net.onLine = true;
    const [a, b, c] = await Promise.all([flush(), flush(), flush()]);
    expect([a, b, c]).toEqual([3, 3, 3]);
    expect(ids(server.state.calls)).toEqual(["w1", "s1", "s2"]);
  });
});

describe("re-sending the same entries", () => {
  it("replaying identical entries leaves one row per id on the server", async () => {
    const batch = [workout("w1"), set("s1", "we1", 1, 60), set("s2", "we1", 2, 60)];
    await queueOffline(batch);
    await queueOffline(batch);
    await goOnlineAndFlush();

    expect(server.state.calls).toHaveLength(6);
    expect(rows("workouts")).toHaveLength(1);
    expect(rows("sets").map((r) => r.id)).toEqual(["s1", "s2"]);
    expect(await pendingCount()).toBe(0);

    // A second full replay after everything synced still adds nothing.
    await queueOffline(batch);
    await goOnlineAndFlush();
    expect(rows("workouts")).toHaveLength(1);
    expect(rows("sets")).toHaveLength(2);
  });

  it("a later edit of the same id wins because entries go out in order", async () => {
    await queueOffline([workout("w1", "first"), workout("w1", "second"), workout("w1", "final")]);
    await goOnlineAndFlush();
    expect(rows("workouts")).toEqual([expect.objectContaining({ id: "w1", notes: "final" })]);
  });

  it("a dropped request stops the pass and resumes from the same entry, in order", async () => {
    server.state.rejectOnce.add("s2");
    await queueOffline([workout("w1"), set("s1", "we1", 1, 60), set("s2", "we1", 2, 60), set("s3", "we1", 3, 60)]);

    expect(await goOnlineAndFlush()).toBe(2);
    expect(await pendingCount()).toBe(2);
    expect(rows("sets").map((r) => r.id)).toEqual(["s1"]);

    expect(await flush()).toBe(2);
    expect(ids(server.state.calls)).toEqual(["w1", "s1", "s2", "s2", "s3"]);
    expect(rows("sets").map((r) => r.id)).toEqual(["s1", "s2", "s3"]);
    expect(await pendingCount()).toBe(0);
  });

  it("a lost response re-sends an entry the server already applied without duplicating it", async () => {
    server.state.lostAckOnce.add("s1");
    await queueOffline([workout("w1"), set("s1", "we1", 1, 60), set("s2", "we1", 2, 60)]);

    expect(await goOnlineAndFlush()).toBe(1);
    expect(rows("sets").map((r) => r.id)).toEqual(["s1"]); // applied, but still queued
    expect(await pendingCount()).toBe(2);

    expect(await flush()).toBe(2);
    expect(ids(server.state.calls)).toEqual(["w1", "s1", "s1", "s2"]);
    expect(rows("workouts")).toHaveLength(1);
    expect(rows("sets").map((r) => r.id)).toEqual(["s1", "s2"]);
  });
});

describe("full offline workout", () => {
  async function logOffline() {
    net.onLine = false;
    await startWorkout();
    await addExercises(["Barbell_Squat"]);
    const w = (await getActive())!;
    const ex = w.exercises[0];
    for (const s of ex.sets) {
      await updateSet(ex.id, s.id, { weight: 80, reps: 5 });
      await toggleSetDone(ex.id, s.id);
    }
    const id = await finishWorkout();
    await idle();
    return { id: id!, setCount: ex.sets.length };
  }

  it("syncs once with no duplicates, even when the whole outbox is replayed", async () => {
    const { id, setCount } = await logOffline();
    const queued = await db.outbox.orderBy("seq").toArray();
    expect(queued.length).toBe(2 + setCount);

    await goOnlineAndFlush();
    expect(rows("workouts").map((r) => r.id)).toEqual([id]);
    expect(rows("workout_exercises")).toHaveLength(1);
    expect(rows("sets")).toHaveLength(setCount);
    // Parent rows go before children.
    expect(server.state.calls.map((c) => c.table)).toEqual(queued.map((q) => q.table));

    // Replay the exact same entries (as if the device re-sent after a crash).
    await db.outbox.bulkAdd(queued.map((q) => ({ table: q.table, op: q.op, row: q.row, created_at: q.created_at })));
    await flush();
    expect(rows("workouts")).toHaveLength(1);
    expect(rows("workout_exercises")).toHaveLength(1);
    expect(rows("sets")).toHaveLength(setCount);
    expect(await pendingCount()).toBe(0);
  });

  it("deleting an unsynced workout drops its queued uploads and sends only the delete", async () => {
    const { id } = await logOffline();
    await deleteWorkout(id);
    await idle();

    const queued = await db.outbox.toArray();
    expect(queued.map((q) => [q.table, q.op, q.row.id])).toEqual([["workouts", "delete", id]]);

    await goOnlineAndFlush();
    expect(server.state.calls).toEqual([{ table: "workouts", op: "delete", id }]);
    expect(rows("workouts")).toEqual([]);
    expect(rows("sets")).toEqual([]);
  });
});
