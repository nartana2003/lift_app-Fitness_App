import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// BLK-02 rework round 3: dead letters are never deleted by pull and get
// re-sent, owner re-claim, atomic deleteWorkout / import, pull guard for
// workouts finished or uploaded during the fetch, writeAndQueue inside an outer
// transaction, photo FK fallback, coded retry cap. In-memory fake Supabase only.

type Row = Record<string, unknown>;

const server = vi.hoisted(() => {
  const state = {
    uid: "11111111-1111-4111-8111-111111111111",
    session: true,
    tables: new Map<string, Map<string, Record<string, unknown>>>(),
    objects: new Map<string, Blob>(),
    calls: [] as string[],
    /** Error for writes of these row ids; `once` errors are removed after use. */
    errors: new Map<string, { code?: string; message: string; once?: boolean }>(),
    /** progress_photos upserts with a workout link fail with this error. */
    photoLinkError: null as null | { code: string; message: string },
    /** Runs after the workouts response is computed, before it is returned. */
    duringPull: null as null | (() => Promise<void>),
  };
  const table = (name: string) => {
    if (!state.tables.has(name)) state.tables.set(name, new Map());
    return state.tables.get(name)!;
  };
  const write = (name: string, op: string, row: Record<string, unknown>, apply: () => void) => {
    const id = row.id as string;
    state.calls.push(`${op} ${name} ${id}`);
    const err = state.errors.get(id);
    if (err) {
      if (err.once) state.errors.delete(id);
      return { error: err };
    }
    if (name === "progress_photos" && op === "upsert" && row.workout_id && state.photoLinkError) return { error: state.photoLinkError };
    apply();
    return { error: null };
  };
  const query = (name: string, filters: [string, unknown][] = []): Record<string, unknown> => {
    const run = async () => {
      const rows = [...table(name).values()].filter((r) => filters.every(([c, v]) => r[c] === v));
      const data = rows.map((r) => (name === "workouts" ? { ...r, workout_exercises: [] } : { ...r }));
      if (name === "workouts" && state.duringPull) {
        const f = state.duringPull;
        state.duringPull = null;
        await f();
      }
      return { data, error: null };
    };
    return {
      eq: (c: string, v: unknown) => query(name, [...filters, [c, v]]),
      gte: () => query(name, filters),
      order: () => query(name, filters),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    };
  };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: state.session ? { user: { id: state.uid } } : null } }),
      signOut: async () => ({ error: null }),
    },
    from: (name: string) => ({
      select: () => query(name),
      upsert: async (row: Record<string, unknown>) => write(name, "upsert", row, () => table(name).set(row.id as string, { ...row })),
      delete: () => ({ eq: async (_c: string, id: string) => write(name, "delete", { id }, () => table(name).delete(id)) }),
    }),
    storage: {
      from: () => ({
        upload: async (path: string, blob: Blob) => {
          state.objects.set(path, blob);
          return { error: null };
        },
        remove: async () => ({ error: null }),
        download: async () => ({ data: null, error: { message: "missing" } }),
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
const sync = await import("../sync");
const { flush, pull, deadLetters, retryDeadLetters, writeAndQueue, deleteWorkout, DEAD_LETTER_KEY, MAX_CODED_RETRIES, MAX_DEAD_LETTER_TRIES } = sync;
const owner = await import("../owner");
const { syncPhotos, queuePhotoDelete, SYNCED_KEY, DELETED_KEY, FAILS_KEY } = await import("../photoSync");
const { photoSignature } = await import("../remote");
const { exportBackup, serializeBackup, parseBackup, importBackup } = await import("../../dataExport");

afterAll(() => vi.unstubAllGlobals());

const UID = server.state.uid;
const OTHER = "22222222-2222-4222-8222-222222222222";
const idle = () => new Promise((r) => setTimeout(r, 0));
const q = (table: string, op: "upsert" | "delete", row: Row, extra: Row = {}) => ({ table, op, row, created_at: "t", ...extra }) as never;
const w = (id: string, started_at: string, ended_at: string | null = null) => ({ id, started_at, ended_at, notes: null, routine_id: null });
const jpeg = () => new Blob(["x"], { type: "image/jpeg" });

beforeEach(async () => {
  await idle();
  server.state.tables.clear();
  server.state.objects.clear();
  server.state.calls.length = 0;
  server.state.errors.clear();
  server.state.photoLinkError = null;
  server.state.duringPull = null;
  server.state.session = true;
  server.state.uid = UID;
  net.onLine = true;
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("dead letters", () => {
  it("a dead-lettered workout is never deleted by a later pull", async () => {
    await db.workouts.put(w("w1", "2026-10-01T08:00:00.000Z", "2026-10-01T09:00:00.000Z"));
    await db.workout_exercises.put({ id: "we2", workout_id: "w2", exercise_id: "Bench", position: 0 });
    await db.workouts.put(w("w2", "2026-10-02T08:00:00.000Z", "2026-10-02T09:00:00.000Z"));
    server.state.errors.set("w1", { code: "23503", message: "fk" });
    server.state.errors.set("s2", { code: "22P02", message: "bad" });
    await db.outbox.bulkAdd([q("workouts", "upsert", { id: "w1" }), q("sets", "upsert", { id: "s2", workout_exercise_id: "we2" })]);
    await flush();
    expect((await deadLetters()).map((d) => d.row.id)).toEqual(["w1", "s2"]);
    await pull(3650);
    expect(await db.workouts.get("w1")).toBeTruthy();
    expect(await db.workouts.get("w2")).toBeTruthy();
  });

  it("retryDeadLetters re-sends in order and gives up after the try limit", async () => {
    await db.meta.put({
      key: DEAD_LETTER_KEY,
      value: [
        { table: "workouts", op: "upsert", row: { id: "w1" }, code: "42703", message: "", at: "t", tries: 1 },
        { table: "workout_exercises", op: "upsert", row: { id: "we1", workout_id: "w1" }, code: "42703", message: "", at: "t", tries: 1 },
        { table: "measurements", op: "upsert", row: { id: "m9" }, code: "23505", message: "", at: "t", tries: MAX_DEAD_LETTER_TRIES },
      ],
    });
    expect(await retryDeadLetters()).toBe(2);
    await flush();
    expect(server.state.calls).toEqual(["upsert workouts w1", "upsert workout_exercises we1"]);
    expect((await deadLetters()).map((d) => d.row.id)).toEqual(["m9"]);
  });

  it("a re-sent item that fails again counts its tries", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: [{ table: "workouts", op: "upsert", row: { id: "w1" }, code: "42703", message: "", at: "t", tries: 2 }] });
    server.state.errors.set("w1", { code: "42703", message: "no column" });
    await retryDeadLetters();
    await flush();
    expect((await deadLetters())[0].tries).toBe(3);
  });

  it("coded non-permanent errors are dead-lettered after the retry cap; network errors are not", async () => {
    server.state.errors.set("m1", { code: "42501", message: "rls" });
    server.state.errors.set("m2", { message: "Failed to fetch" });
    await db.outbox.add(q("measurements", "upsert", { id: "m1" }));
    for (let i = 0; i < MAX_CODED_RETRIES; i++) await flush();
    expect((await deadLetters()).map((d) => d.row.id)).toEqual(["m1"]);
    await db.outbox.add(q("measurements", "upsert", { id: "m2" }));
    for (let i = 0; i < MAX_CODED_RETRIES + 2; i++) await flush();
    expect(await db.outbox.count()).toBe(1);
  });
});

describe("pull guard", () => {
  it("keeps a workout finished during the fetch", async () => {
    server.state.duringPull = async () => {
      await db.workouts.put(w("fin", "2026-01-01T08:00:00.000Z", new Date(Date.now() + 60_000).toISOString()));
    };
    await pull(3650);
    expect(await db.workouts.get("fin")).toBeTruthy();
  });

  it("keeps a workout uploaded while the fetch was in flight", async () => {
    server.state.duringPull = async () => {
      await db.workouts.put(w("up", "2026-01-01T08:00:00.000Z", "2026-01-01T09:00:00.000Z"));
      await db.outbox.add(q("workouts", "upsert", w("up", "2026-01-01T08:00:00.000Z", "2026-01-01T09:00:00.000Z")));
      await flush(); // sent now, so the outbox is empty again when pull applies
    };
    await pull(3650);
    expect(server.state.calls).toContain("upsert workouts up");
    expect(await db.outbox.count()).toBe(0);
    expect(await db.workouts.get("up")).toBeTruthy();
  });
});

describe("atomic writes", () => {
  it("deleteWorkout rolls back the local delete when queuing fails", async () => {
    await db.workouts.put(w("w1", "2026-10-01T08:00:00.000Z"));
    const spy = vi.spyOn(db.outbox, "bulkAdd").mockRejectedValueOnce(new Error("disk full"));
    await expect(deleteWorkout("w1")).rejects.toThrow();
    spy.mockRestore();
    expect(await db.workouts.get("w1")).toBeTruthy();
  });

  it("a backup import rolls back when queuing fails", async () => {
    await db.workouts.put(w("w1", "2026-10-01T08:00:00.000Z", "2026-10-01T09:00:00.000Z"));
    const text = serializeBackup(await exportBackup(new Date("2026-10-16T12:00:00.000Z")));
    await Promise.all(db.tables.map((t) => t.clear()));
    const parsed = parseBackup(text);
    if (!parsed.ok) throw new Error("bad backup");
    const spy = vi.spyOn(db.outbox, "bulkAdd").mockRejectedValueOnce(new Error("disk full"));
    await expect(importBackup(parsed.backup)).rejects.toThrow();
    spy.mockRestore();
    expect(await db.workouts.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it("writeAndQueue inside an outer transaction commits with it and uploads afterwards", async () => {
    await db.transaction("rw", [db.measurements, db.outbox], async () => {
      await writeAndQueue([db.measurements], async () => {
        await db.measurements.put({ id: "m1", type: "weight", value: 80, date: "2026-10-01" });
        return [{ table: "measurements", op: "upsert", row: { id: "m1", type: "weight", value: 80, date: "2026-10-01" } }];
      });
    });
    await idle();
    await flush();
    expect(server.table("measurements").has("m1")).toBe(true);
  });
});

describe("photos", () => {
  it("a workout link the server rejects (FK) is sent once without the link; the local link stays", async () => {
    await db.workouts.put(w("w1", "t"));
    await db.photos.put({ id: "p1", taken_at: "t", pose: "front", blob: jpeg(), workout_id: "w1" } as never);
    server.state.photoLinkError = { code: "23503", message: "fk" };
    expect((await syncPhotos()).uploaded).toBe(1);
    expect(server.table("progress_photos").get("p1")).toMatchObject({ workout_id: null });
    expect(await db.photos.get("p1")).toMatchObject({ workout_id: "w1" });
  });

  it("a tombstone clears the photo's failure record", async () => {
    await db.meta.put({ key: FAILS_KEY, value: { p1: { n: 3, next: 0 } } });
    net.onLine = false;
    await queuePhotoDelete("p1");
    expect((await db.meta.get(FAILS_KEY))?.value).toEqual({});
  });
});

describe("owner", () => {
  it("uses the same meta keys as sync and photoSync", () => {
    expect(owner.DEAD_KEY).toBe(DEAD_LETTER_KEY);
    expect(owner.PHOTOS_SYNCED_KEY).toBe(SYNCED_KEY);
    expect(owner.PHOTOS_DELETED_KEY).toBe(DELETED_KEY);
  });

  it("another account takes the device over when nothing is unsent", async () => {
    await db.meta.put({ key: owner.OWNER_KEY, value: OTHER });
    const p = { id: "p1", taken_at: "t", pose: "front" as const, blob: jpeg() };
    await db.photos.put(p);
    await db.meta.put({ key: SYNCED_KEY, value: { p1: photoSignature(p) } });
    expect(await owner.claimOwner(UID)).toBe(true);
    expect(await owner.getOwner()).toBe(UID);
  });

  it("refuses while the other account has unsent data, and says so", async () => {
    const seen: number[] = [];
    win.addEventListener(owner.OWNER_MISMATCH_EVENT, () => seen.push(1));
    for (const setup of [
      async () => void (await db.outbox.add(q("measurements", "upsert", { id: "m1" }))),
      async () => void (await db.meta.put({ key: DEAD_LETTER_KEY, value: [{ row: { id: "x" } }] })),
      async () => void (await db.photos.put({ id: "p2", taken_at: "t", pose: null, blob: jpeg() })),
      async () => void (await db.meta.put({ key: DELETED_KEY, value: ["p3"] })),
    ]) {
      await Promise.all(db.tables.map((t) => t.clear()));
      await db.meta.put({ key: owner.OWNER_KEY, value: OTHER });
      await setup();
      expect(await owner.claimOwner(UID)).toBe(false);
      expect(await owner.getOwner()).toBe(OTHER);
    }
    expect(seen).toHaveLength(4);
  });
});
