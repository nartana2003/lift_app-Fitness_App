import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// BLK-02 rework (offline-sync review): poison items, pull racing local writes,
// photo delete/upload races, unknown workout links, duplicate planned days,
// user switch, FK guard, startSync cleanup. In-memory fake Supabase only.

type Row = Record<string, unknown>;

const server = vi.hoisted(() => {
  const state = {
    uid: "11111111-1111-4111-8111-111111111111",
    session: true,
    tables: new Map<string, Map<string, Record<string, unknown>>>(),
    objects: new Map<string, Blob>(),
    calls: [] as string[],
    /** Error returned for writes of these row ids (every time). */
    errors: new Map<string, { code?: string; message: string }>(),
    /** Runs while a workouts pull request is in flight. */
    duringPull: null as null | (() => Promise<void>),
    /** Runs while a photo upload is in flight. */
    duringUpload: null as null | (() => Promise<void>),
  };
  const table = (name: string) => {
    if (!state.tables.has(name)) state.tables.set(name, new Map());
    return state.tables.get(name)!;
  };
  const write = (name: string, op: string, id: string, apply: () => void) => {
    state.calls.push(`${op} ${name} ${id}`);
    const err = state.errors.get(id);
    if (err) return { error: err };
    apply();
    return { error: null };
  };
  const query = (name: string, filters: [string, unknown][] = []): Record<string, unknown> => {
    const run = async () => {
      if (name === "workouts" && state.duringPull) {
        const f = state.duringPull;
        state.duringPull = null;
        await f();
      }
      const rows = [...table(name).values()].filter((r) => filters.every(([c, v]) => r[c] === v));
      return { data: rows.map((r) => (name === "workouts" ? { ...r, workout_exercises: [] } : { ...r })), error: null };
    };
    return {
      eq: (c: string, v: unknown) => query(name, [...filters, [c, v]]),
      gte: () => query(name, filters),
      order: () => query(name, filters),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    };
  };
  const client = {
    auth: { getSession: async () => ({ data: { session: state.session ? { user: { id: state.uid } } : null } }) },
    from: (name: string) => ({
      select: () => query(name),
      upsert: async (row: Record<string, unknown>) => write(name, "upsert", row.id as string, () => table(name).set(row.id as string, { ...row })),
      delete: () => ({ eq: async (_c: string, id: string) => write(name, "delete", id, () => table(name).delete(id)) }),
    }),
    storage: {
      from: () => ({
        upload: async (path: string, blob: Blob) => {
          state.calls.push(`upload ${path}`);
          if (state.duringUpload) {
            const f = state.duringUpload;
            state.duringUpload = null;
            await f();
          }
          state.objects.set(path, blob);
          return { error: null };
        },
        remove: async (paths: string[]) => {
          state.calls.push(`remove ${paths.join(",")}`);
          for (const p of paths) state.objects.delete(p);
          return { error: null };
        },
        download: async (path: string) => {
          const b = state.objects.get(path);
          return b ? { data: b, error: null } : { data: null, error: { message: "missing" } };
        },
      }),
    },
  };
  return { state, table, client };
});

vi.mock("@/lib/supabase/configured", () => ({ supabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: () => server.client }));

const net = { onLine: true };
const win = new EventTarget();
vi.stubGlobal("navigator", net);
vi.stubGlobal("window", win);

const { db } = await import("../db");
const { flush, pull, pullTables, startSync, deadLetters, writeAndQueue, DEAD_LETTER_KEY } = await import("../sync");
const { syncPhotos, queuePhotoDelete } = await import("../photoSync");
const { OWNER_KEY, OWNER_MISMATCH_EVENT } = await import("../owner");
const { photoPath, classifySyncError, outboxChildren } = await import("../remote");
const { createRoutine, deleteRoutine } = await import("../../routines");

afterAll(() => vi.unstubAllGlobals());

const UID = server.state.uid;
const put = (t: string, row: Row) => server.table(t).set(row.id as string, row);
const jpeg = (s = "x") => new Blob([s], { type: "image/jpeg" });
const idle = () => new Promise((r) => setTimeout(r, 0));
const q = (table: string, op: "upsert" | "delete", row: Row) => ({ table, op, row, created_at: "t" }) as never;
const remoteDay = (id: string, date: string, extra: Row = {}) => ({
  id, date, routine_id: null, status: "planned", workout_id: null, skip_reason: null, skip_note: null,
  moved_to: null, moved_from: null, was_marked: false, created_at: "2026-10-20T00:00:00Z", ...extra,
});

beforeEach(async () => {
  await idle();
  server.state.tables.clear();
  server.state.objects.clear();
  server.state.calls.length = 0;
  server.state.errors.clear();
  server.state.duringPull = null;
  server.state.duringUpload = null;
  server.state.session = true;
  server.state.uid = UID;
  net.onLine = true;
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("classifySyncError / outboxChildren", () => {
  it("permanent only for integrity, data and schema errors", () => {
    for (const code of ["23503", "23505", "22P02", "42703", "PGRST204"]) expect(classifySyncError({ code })).toBe("permanent");
    for (const e of [{ code: "" }, { code: "PGRST301" }, { code: "42501" }, { code: "08006" }, { message: "Failed to fetch" }, null]) {
      expect(classifySyncError(e)).toBe("retry");
    }
  });

  it("finds a workout's exercises and sets, a routine's exercises", () => {
    const items = [
      { table: "workout_exercises", op: "upsert", row: { id: "we1", workout_id: "w1" } },
      { table: "sets", op: "upsert", row: { id: "s1", workout_exercise_id: "we1" } },
      { table: "sets", op: "upsert", row: { id: "s9", workout_exercise_id: "other" } },
      { table: "routine_exercises", op: "upsert", row: { id: "re1", routine_id: "r1" } },
    ] as const;
    const ids = (xs: readonly { row: Row }[]) => xs.map((x) => x.row.id);
    expect(ids(outboxChildren({ table: "workouts", op: "upsert", row: { id: "w1" } }, items as never))).toEqual(["we1", "s1"]);
    expect(ids(outboxChildren({ table: "routines", op: "upsert", row: { id: "r1" } }, items as never))).toEqual(["re1"]);
    expect(outboxChildren({ table: "workouts", op: "delete", row: { id: "w1" } }, items as never)).toEqual([]);
  });
});

describe("flush with a poison item", () => {
  it("moves a permanently rejected item and its children to dead letters, later items still go", async () => {
    server.state.errors.set("w1", { code: "23503", message: "fk violation" });
    await db.outbox.bulkAdd([
      q("workouts", "upsert", { id: "w1" }),
      q("workout_exercises", "upsert", { id: "we1", workout_id: "w1" }),
      q("sets", "upsert", { id: "s1", workout_exercise_id: "we1" }),
      q("measurements", "upsert", { id: "m1", type: "weight", value: 80, date: "2026-10-01" }),
    ]);
    expect(await flush()).toBe(1);
    expect(server.state.calls).toEqual(["upsert workouts w1", "upsert measurements m1"]);
    expect(await db.outbox.count()).toBe(0);
    const dead = await deadLetters();
    expect(dead.map((d) => [d.table, d.row.id, d.code])).toEqual([
      ["workouts", "w1", "23503"],
      ["workout_exercises", "we1", "23503"],
      ["sets", "s1", "23503"],
    ]);
  });

  it("an unknown column (0002 not applied yet) does not block the queue either", async () => {
    server.state.errors.set("d1", { code: "PGRST204", message: "column not found" });
    await db.outbox.bulkAdd([q("planned_days", "upsert", { id: "d1", date: "2026-10-27" }), q("measurements", "upsert", { id: "m1" })]);
    expect(await flush()).toBe(1);
    expect((await deadLetters()).map((d) => d.row.id)).toEqual(["d1"]);
  });

  it("network, auth and server errors keep the item and the order", async () => {
    server.state.errors.set("w1", { code: "PGRST301", message: "JWT expired" });
    await db.outbox.bulkAdd([q("workouts", "upsert", { id: "w1" }), q("measurements", "upsert", { id: "m1" })]);
    expect(await flush()).toBe(0);
    expect(server.state.calls).toEqual(["upsert workouts w1"]);
    expect(await db.outbox.count()).toBe(2);
    expect(await deadLetters()).toEqual([]);
  });

  it("caps the dead-letter list", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: Array.from({ length: 200 }, (_, i) => ({ row: { id: `old${i}` } })) });
    server.state.errors.set("x", { code: "23505", message: "dup" });
    await db.outbox.add(q("measurements", "upsert", { id: "x" }));
    await flush();
    const dead = await deadLetters();
    expect(dead).toHaveLength(200);
    expect(dead.at(-1)!.row.id).toBe("x");
  });

  it("drops a link to a routine deleted on this device instead of failing the FK", async () => {
    await db.outbox.add(q("planned_days", "upsert", { id: "d1", date: "2026-10-27", routine_id: "gone" }));
    await flush();
    expect(server.table("planned_days").get("d1")).toMatchObject({ routine_id: null });
  });

  it("deleting a routine drops its unsent uploads and sends only the delete", async () => {
    net.onLine = false;
    const id = await createRoutine({ name: "Push", exercises: [{ exercise_id: "Bench" }] });
    await deleteRoutine(id);
    await idle();
    expect((await db.outbox.toArray()).map((i) => [i.table, i.op])).toEqual([["routines", "delete"]]);
  });
});

describe("pull racing a local write", () => {
  const w = (id: string, started_at: string) => ({ id, started_at, ended_at: null, notes: null, routine_id: null });

  it("a workout saved and queued while the request is in flight is never deleted", async () => {
    server.state.duringPull = async () => {
      await writeAndQueue([db.workouts], async () => {
        await db.workouts.put(w("new", "2026-10-26T08:00:00.000Z"));
        return [{ table: "workouts", op: "upsert", row: w("new", "2026-10-26T08:00:00.000Z") }];
      });
    };
    net.onLine = true;
    // Keep the queued item from being sent before pull's transaction runs.
    server.state.errors.set("new", { message: "offline" });
    await pull(3650);
    expect(await db.workouts.get("new")).toBeTruthy();
  });

  it("a workout started after the request began is kept even with an empty outbox", async () => {
    server.state.duringPull = async () => {
      await db.workouts.put(w("fresh", new Date(Date.now() + 60_000).toISOString()));
    };
    await pull(3650);
    expect(await db.workouts.get("fresh")).toBeTruthy();
  });

  it("an old local workout missing on the server is still removed (deleted elsewhere)", async () => {
    await db.workouts.put(w("old", "2026-01-01T08:00:00.000Z"));
    await pull(3650);
    expect(await db.workouts.get("old")).toBeUndefined();
  });
});

describe("duplicate planned days across devices", () => {
  it("keeps the done day over a newer planned one and deletes the loser on the server", async () => {
    put("planned_days", remoteDay("done", "2026-10-27", { status: "done", created_at: "2026-10-01T00:00:00Z" }));
    put("planned_days", remoteDay("newer", "2026-10-27", { created_at: "2026-10-05T00:00:00Z" }));
    await pullTables();
    expect((await db.planned_days.toArray()).map((d) => d.id)).toEqual(["done"]);
    await flush();
    expect(server.state.calls).toContain("delete planned_days newer");
    expect(server.table("planned_days").has("newer")).toBe(false);
  });
});

describe("photos", () => {
  it("a photo deleted while its upload is in flight does not come back", async () => {
    await db.photos.put({ id: "p1", taken_at: "t", pose: "front", blob: jpeg() });
    server.state.duringUpload = async () => {
      await db.photos.delete("p1");
      net.onLine = false; // queue only; the running sync picks the tombstone up
      await queuePhotoDelete("p1");
      net.onLine = true;
    };
    expect((await syncPhotos()).uploaded).toBe(0);
    await syncPhotos();
    expect(server.table("progress_photos").has("p1")).toBe(false);
    expect(server.state.objects.has(photoPath(UID, "p1"))).toBe(false);
    expect(await db.photos.get("p1")).toBeUndefined();
  });

  it("a photo whose workout is not on this device keeps the link when the server has the workout", async () => {
    put("workouts", { id: "wRemote" });
    await db.photos.put({ id: "p1", taken_at: "t", pose: "front", blob: jpeg(), workout_id: "wRemote" } as never);
    expect((await syncPhotos()).uploaded).toBe(1);
    expect(server.table("progress_photos").get("p1")).toMatchObject({ workout_id: "wRemote" });
  });

  it("waits while the linked workout's exercises or sets are still queued", async () => {
    await db.workouts.put({ id: "w1", started_at: "t", ended_at: null, notes: null, routine_id: null });
    await db.workout_exercises.put({ id: "we1", workout_id: "w1", exercise_id: "Bench", position: 0 });
    await db.outbox.add(q("sets", "upsert", { id: "s1", workout_exercise_id: "we1" }));
    server.state.errors.set("s1", { message: "offline" }); // keep it queued
    await db.photos.put({ id: "p1", taken_at: "t", pose: "front", blob: jpeg(), workout_id: "w1" } as never);
    expect((await syncPhotos()).uploaded).toBe(0);
    await db.outbox.clear();
    expect((await syncPhotos()).uploaded).toBe(1);
    expect(server.table("progress_photos").get("p1")).toMatchObject({ workout_id: "w1" });
  });
});

describe("another account on the same browser", () => {
  it("the first account claims the device; a second one cannot flush, pull or upload photos", async () => {
    await db.outbox.add(q("measurements", "upsert", { id: "m1" }));
    expect(await flush()).toBe(1);
    expect((await db.meta.get(OWNER_KEY))?.value).toBe(UID);

    server.state.uid = "22222222-2222-4222-8222-222222222222";
    server.state.calls.length = 0;
    const seen: string[] = [];
    win.addEventListener(OWNER_MISMATCH_EVENT, () => seen.push("x"));
    await db.outbox.add(q("measurements", "upsert", { id: "m2" }));
    await db.photos.put({ id: "p1", taken_at: "t", pose: "front", blob: jpeg() });
    put("routines", { id: "r1", name: "Theirs", created_at: "t" });

    expect(await flush()).toBe(0);
    expect(await syncPhotos()).toEqual({ uploaded: 0, downloaded: 0, deleted: 0 });
    await db.outbox.clear();
    await pullTables();
    expect(server.state.calls).toEqual([]);
    expect(await db.routines.count()).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("startSync", () => {
  it("removes its online listener on cleanup", () => {
    const add = vi.spyOn(win, "addEventListener");
    const remove = vi.spyOn(win, "removeEventListener");
    const stop = startSync();
    const handler = add.mock.calls.find((c) => c[0] === "online")![1];
    stop();
    expect(remove).toHaveBeenCalledWith("online", handler);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe("round 3: dead letters", () => {
  it("a workout rejected with 23503 keeps the local workout and its sets after a pull", async () => {
    await db.workouts.put({ id: "w1", started_at: "2026-10-01T08:00:00.000Z", ended_at: "2026-10-01T09:00:00.000Z", notes: null, routine_id: null });
    await db.workout_exercises.put({ id: "we1", workout_id: "w1", exercise_id: "Bench", position: 0 });
    await db.sets.put({ id: "s1", workout_exercise_id: "we1", set_no: 1, reps: 5, weight: 100, is_warmup: false, rir: null, completed_at: "2026-10-01T08:30:00.000Z" });
    server.state.errors.set("w1", { code: "23503", message: "fk" });
    await db.outbox.bulkAdd([
      q("workouts", "upsert", { id: "w1" }),
      q("workout_exercises", "upsert", { id: "we1", workout_id: "w1" }),
      q("sets", "upsert", { id: "s1", workout_exercise_id: "we1" }),
    ]);
    await flush();
    expect(await db.outbox.count()).toBe(0);
    await pull(3650);
    expect(await db.workouts.get("w1")).toBeTruthy();
    expect(await db.sets.get("s1")).toBeTruthy();
  });

  it("an item dead-lettered with 42703 is re-sent and succeeds on the next startSync", async () => {
    server.state.errors.set("d1", { code: "42703", message: "column moved_to does not exist" });
    await db.outbox.add(q("planned_days", "upsert", { id: "d1", date: "2026-10-27" }));
    await flush();
    expect((await deadLetters()).map((d) => d.row.id)).toEqual(["d1"]);
    server.state.errors.clear(); // 0002 applied
    const stop = startSync();
    await vi.waitFor(async () => expect(server.table("planned_days").has("d1")).toBe(true));
    stop();
    expect(await deadLetters()).toEqual([]);
  });
});
