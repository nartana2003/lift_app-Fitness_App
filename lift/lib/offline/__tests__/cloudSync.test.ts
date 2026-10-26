import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Cross-device sync (pullTables), outbox row mapping (flush) and the progress
// photo cloud backup (photoSync), against an in-memory fake Supabase client.
// No network, no real project.

type Row = Record<string, unknown>;

const server = vi.hoisted(() => {
  const UID = "11111111-1111-4111-8111-111111111111";
  const state = {
    tables: new Map<string, Map<string, Record<string, unknown>>>(),
    objects: new Map<string, Blob>(),
    failSelect: new Set<string>(),
    failUpload: new Set<string>(),
    failUpsert: new Set<string>(),
    calls: [] as string[],
    session: true,
  };
  const table = (name: string) => {
    if (!state.tables.has(name)) state.tables.set(name, new Map());
    return state.tables.get(name)!;
  };
  const query = (name: string, filters: [string, unknown][] = []) => {
    const run = async () => {
      if (state.failSelect.has(name)) return { data: null, error: { message: "boom" } };
      const rows = [...table(name).values()].filter((r) => filters.every(([c, v]) => r[c] === v));
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    return {
      eq: (c: string, v: unknown) => query(name, [...filters, [c, v]]),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    };
  };
  const client = {
    auth: { getSession: async () => ({ data: { session: state.session ? { user: { id: UID } } : null } }) },
    from: (name: string) => ({
      select: () => query(name),
      upsert: async (row: Record<string, unknown>) => {
        state.calls.push(`upsert ${name} ${row.id}`);
        if (state.failUpsert.has(String(row.id))) return { error: { message: "fk" } };
        table(name).set(row.id as string, { ...row });
        return { error: null };
      },
      delete: () => ({
        eq: async (_c: string, id: string) => {
          state.calls.push(`delete ${name} ${id}`);
          table(name).delete(id);
          return { error: null };
        },
      }),
    }),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, blob: Blob, opts: { upsert: boolean }) => {
          state.calls.push(`upload ${bucket} ${path} ${opts.upsert}`);
          if (state.failUpload.has(path)) return { error: { message: "nope" } };
          state.objects.set(path, blob);
          return { error: null };
        },
        remove: async (paths: string[]) => {
          state.calls.push(`remove ${paths.join(",")}`);
          for (const p of paths) state.objects.delete(p);
          return { error: null };
        },
        download: async (path: string) => {
          state.calls.push(`download ${path}`);
          const b = state.objects.get(path);
          return b ? { data: b, error: null } : { data: null, error: { message: "missing" } };
        },
      }),
    },
  };
  return { state, table, client, UID };
});

vi.mock("@/lib/supabase/configured", () => ({ supabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: () => server.client }));

const net = { onLine: true };
vi.stubGlobal("navigator", net);
vi.stubGlobal("window", new EventTarget());

const { db } = await import("../db");
const { flush, pullTables } = await import("../sync");
const { syncPhotos, queuePhotoDelete, SYNCED_KEY, DELETED_KEY } = await import("../photoSync");
const { photoPath } = await import("../remote");

afterAll(() => vi.unstubAllGlobals());

const UID = server.UID;
const put = (t: string, row: Row) => server.table(t).set(row.id as string, row);
const jpeg = (s = "x") => new Blob([s], { type: "image/jpeg" });

beforeEach(async () => {
  server.state.tables.clear();
  server.state.objects.clear();
  server.state.failSelect.clear();
  server.state.failUpload.clear();
  server.state.failUpsert.clear();
  server.state.calls.length = 0;
  server.state.session = true;
  net.onLine = true;
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("flush maps rows to the server schema", () => {
  it("sends planned_days with moved_to dates and explicit was_marked, routines with split_day_id", async () => {
    await db.outbox.bulkAdd([
      { table: "planned_days", op: "upsert", row: { id: "d1", date: "2026-10-26", status: "moved", moved_to: "2026-10-28", moved_from: null }, created_at: "t" },
      { table: "routines", op: "upsert", row: { id: "r1", name: "Push" }, created_at: "t" },
      { table: "exercises", op: "upsert", row: { id: "custom-1", name: "X", custom: true }, created_at: "t" },
    ]);
    expect(await flush()).toBe(3);
    expect(server.table("planned_days").get("d1")).toMatchObject({ moved_to: "2026-10-28", was_marked: false });
    expect(server.table("routines").get("r1")).toMatchObject({ split_day_id: null });
    expect(server.table("exercises").get("custom-1")).toEqual({ id: "custom-1", name: "X", owner_id: UID });
  });
});

describe("pullTables", () => {
  const remoteDay = (id: string, date: string, extra: Row = {}) => ({
    id, date, routine_id: null, status: "planned", workout_id: null, skip_reason: null, skip_note: null,
    moved_to: null, moved_from: null, was_marked: false, created_at: "2026-10-20T00:00:00Z", user_id: UID, ...extra,
  });

  it("brings planned days, routines, routine exercises, measurements and custom exercises down", async () => {
    put("planned_days", remoteDay("d1", "2026-10-27", { moved_from: "2026-10-26", was_marked: true }));
    put("routines", { id: "r1", name: "Push", source: "manual", kind: "routine", created_at: "t", split_day_id: "day-1", user_id: UID });
    put("routine_exercises", { id: "re1", routine_id: "r1", exercise_id: "Bench", position: 0, target_sets: 3, target_reps: "8-12" });
    put("measurements", { id: "m1", type: "weight", value: 81, date: "2026-10-20" });
    put("exercises", { id: "custom-1", name: "Hip thrust", owner_id: UID, muscle_groups: ["Glutes"] });
    put("exercises", { id: "custom-2", name: "Someone else's", owner_id: "other" });

    await pullTables();
    expect(await db.planned_days.get("d1")).toMatchObject({ date: "2026-10-27", moved_from: "2026-10-26", was_marked: true });
    expect(await db.routines.get("r1")).toMatchObject({ name: "Push", split_day_id: "day-1" });
    expect(await db.routine_exercises.get("re1")).toMatchObject({ exercise_id: "Bench" });
    expect(await db.measurements.get("m1")).toEqual({ id: "m1", type: "weight", value: 81, date: "2026-10-20" });
    expect((await db.custom_exercises.toArray()).map((c) => c.id)).toEqual(["custom-1"]);
  });

  it("replaces a local planned day on the same date with another id (unique date index)", async () => {
    await db.planned_days.put({ ...remoteDay("local", "2026-10-27"), user_id: undefined } as never);
    put("planned_days", remoteDay("remote", "2026-10-27"));
    await pullTables();
    expect((await db.planned_days.toArray()).map((d) => d.id)).toEqual(["remote"]);
  });

  it("replaces a local measurement for the same type and day", async () => {
    await db.measurements.put({ id: "local", type: "weight", value: 80, date: "2026-10-20" });
    put("measurements", { id: "remote", type: "weight", value: 81, date: "2026-10-20" });
    await pullTables();
    expect(await db.measurements.toArray()).toEqual([{ id: "remote", type: "weight", value: 81, date: "2026-10-20" }]);
  });

  it("never deletes local rows and skips a table that fails to load", async () => {
    await db.routines.put({ id: "keep", name: "Mine", day_label: null, source: "manual", kind: "routine", source_url: null, platform: null, thumbnail_url: null, creator: null, notes: null, created_at: "t" });
    server.state.failSelect.add("measurements");
    put("measurements", { id: "m1", type: "weight", value: 81, date: "2026-10-20" });
    put("routines", { id: "r2", name: "Pull", created_at: "t" });
    await pullTables();
    expect((await db.routines.toArray()).map((r) => r.id).sort()).toEqual(["keep", "r2"]);
    expect(await db.measurements.count()).toBe(0);
  });

  it("does nothing with unsent local edits, offline or signed out", async () => {
    put("routines", { id: "r1", name: "Push", created_at: "t" });
    await db.outbox.add({ table: "routines", op: "upsert", row: { id: "x" }, created_at: "t" });
    await pullTables();
    expect(await db.routines.count()).toBe(0);
    await db.outbox.clear();
    net.onLine = false;
    await pullTables();
    expect(await db.routines.count()).toBe(0);
    net.onLine = true;
    server.state.session = false;
    await pullTables();
    expect(await db.routines.count()).toBe(0);
  });
});

describe("syncPhotos", () => {
  it("uploads new photos to the user's folder with a progress_photos row, once", async () => {
    await db.workouts.put({ id: "w1", started_at: "t", ended_at: null, notes: null, routine_id: null });
    await db.photos.put({ id: "p1", taken_at: "2026-10-01T09:00:00Z", pose: "front", blob: jpeg(), workout_id: "w1" } as never);
    await db.photos.put({ id: "p2", taken_at: "2026-10-02T09:00:00Z", pose: null, blob: jpeg() });

    expect(await syncPhotos()).toEqual({ uploaded: 2, downloaded: 0, deleted: 0 });
    expect(server.state.objects.has(photoPath(UID, "p1"))).toBe(true);
    expect(server.table("progress_photos").get("p1")).toEqual({
      id: "p1", taken_at: "2026-10-01T09:00:00Z", pose: "front", storage_path: `${UID}/p1.jpg`, workout_id: "w1",
    });
    expect(server.table("progress_photos").get("p2")).toMatchObject({ pose: null, workout_id: null });
    expect(server.state.calls).toContain(`upload progress-photos ${UID}/p1.jpg true`);

    server.state.calls.length = 0;
    expect(await syncPhotos()).toEqual({ uploaded: 0, downloaded: 0, deleted: 0 });
    expect(server.state.calls.filter((c) => c.startsWith("upload"))).toEqual([]);
  });

  it("re-uploads a replaced photo (same id, new image)", async () => {
    await db.photos.put({ id: "p1", taken_at: "2026-10-01T09:00:00Z", pose: "front", blob: jpeg("a") });
    await syncPhotos();
    await db.photos.put({ id: "p1", taken_at: "2026-10-01T09:00:00Z", pose: "front", blob: jpeg("bigger") });
    expect((await syncPhotos()).uploaded).toBe(1);
    expect(server.state.objects.get(photoPath(UID, "p1"))!.size).toBe(6);
  });

  it("waits for the linked workout to upload, and drops a link to a missing workout", async () => {
    await db.workouts.put({ id: "w1", started_at: "t", ended_at: null, notes: null, routine_id: null });
    await db.outbox.add({ table: "workouts", op: "upsert", row: { id: "w1" }, created_at: "t" });
    await db.photos.put({ id: "p1", taken_at: "t1", pose: "front", blob: jpeg(), workout_id: "w1" } as never);
    await db.photos.put({ id: "p2", taken_at: "t2", pose: "back", blob: jpeg(), workout_id: "gone" } as never);
    expect((await syncPhotos()).uploaded).toBe(1);
    expect(server.table("progress_photos").has("p1")).toBe(false);
    expect(server.table("progress_photos").get("p2")).toMatchObject({ workout_id: null });
  });

  it("retries a failed upload next time", async () => {
    await db.photos.put({ id: "p1", taken_at: "t", pose: "front", blob: jpeg() });
    server.state.failUpload.add(photoPath(UID, "p1"));
    expect((await syncPhotos()).uploaded).toBe(0);
    expect((await db.meta.get(SYNCED_KEY))?.value ?? {}).toEqual({});
    server.state.failUpload.clear();
    expect((await syncPhotos()).uploaded).toBe(1);
  });

  it("downloads photos from another device, ignoring foreign paths", async () => {
    server.state.objects.set(`${UID}/p9.jpg`, jpeg("remote"));
    put("progress_photos", { id: "p9", taken_at: "2026-10-03T09:00:00Z", pose: "side", storage_path: `${UID}/p9.jpg`, workout_id: "w9" });
    put("progress_photos", { id: "bad", taken_at: "2026-10-03T09:00:00Z", pose: "side", storage_path: `other/bad.jpg`, workout_id: null });
    expect(await syncPhotos()).toEqual({ uploaded: 0, downloaded: 1, deleted: 0 });
    const p = (await db.photos.get("p9")) as unknown as Row;
    expect(p).toMatchObject({ id: "p9", pose: "side", workout_id: "w9" });
    expect(await db.photos.get("bad")).toBeUndefined();
    expect(server.state.calls).not.toContain("download other/bad.jpg");
    // Downloaded photos count as synced: no upload back.
    server.state.calls.length = 0;
    await syncPhotos();
    expect(server.state.calls.filter((c) => c.startsWith("upload"))).toEqual([]);
  });

  it("deletes the cloud copy of a photo deleted on this device and does not download it again", async () => {
    await db.photos.put({ id: "p1", taken_at: "t", pose: "front", blob: jpeg() });
    await syncPhotos();
    await db.photos.delete("p1");
    net.onLine = false; // queue only
    await queuePhotoDelete("p1");
    expect((await db.meta.get(DELETED_KEY))?.value).toEqual(["p1"]);
    net.onLine = true;
    expect((await syncPhotos()).deleted).toBe(1);
    expect(server.table("progress_photos").has("p1")).toBe(false);
    expect(server.state.objects.has(photoPath(UID, "p1"))).toBe(false);
    expect(await db.photos.get("p1")).toBeUndefined();
    expect((await db.meta.get(DELETED_KEY))?.value).toEqual([]);
  });

  it("a never-synced photo deleted locally queues nothing", async () => {
    net.onLine = false;
    await queuePhotoDelete("never");
    expect((await db.meta.get(DELETED_KEY))?.value).toEqual([]);
  });

  it("does nothing signed out or offline", async () => {
    await db.photos.put({ id: "p1", taken_at: "t", pose: "front", blob: jpeg() });
    server.state.session = false;
    expect(await syncPhotos()).toEqual({ uploaded: 0, downloaded: 0, deleted: 0 });
    server.state.session = true;
    net.onLine = false;
    expect(await syncPhotos()).toEqual({ uploaded: 0, downloaded: 0, deleted: 0 });
    expect(server.state.calls).toEqual([]);
  });
});
