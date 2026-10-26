import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// QA: pullTables merge rules and photoSync ordering against an in-memory fake Supabase.
// No network, no real project.

type Row = Record<string, unknown>;

const server = vi.hoisted(() => {
  const UID = "22222222-2222-4222-8222-222222222222";
  const state = {
    tables: new Map<string, Map<string, Record<string, unknown>>>(),
    objects: new Map<string, Blob>(),
    calls: [] as string[],
    failSelect: new Set<string>(),
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
        upload: async (path: string, blob: Blob) => {
          state.calls.push(`upload ${bucket} ${path}`);
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
const { pullTables, flush } = await import("../sync");
const { syncPhotos, MAX_PHOTO_BYTES } = await import("../photoSync");

afterAll(() => vi.unstubAllGlobals());

const UID = server.UID;
const put = (t: string, row: Row) => server.table(t).set(row.id as string, row);
const jpeg = (s = "x") => new Blob([s], { type: "image/jpeg" });
const remoteDay = (id: string, date: string, extra: Row = {}) => ({
  id, date, routine_id: null, status: "planned", workout_id: null, skip_reason: null, skip_note: null,
  moved_to: null, moved_from: null, was_marked: false, created_at: "2026-10-20T00:00:00Z", ...extra,
});
const localDay = (id: string, date: string, extra: Row = {}) => {
  const { was_marked, ...rest } = remoteDay(id, date, extra);
  return (was_marked ? { ...rest, was_marked: true } : rest) as never;
};

beforeEach(async () => {
  server.state.tables.clear();
  server.state.objects.clear();
  server.state.calls.length = 0;
  server.state.failSelect.clear();
  server.state.session = true;
  net.onLine = true;
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("pullTables merge", () => {
  it("two server rows on one date: the newest wins, one local row remains", async () => {
    put("planned_days", remoteDay("old", "2026-10-27", { created_at: "2026-10-01T00:00:00Z" }));
    put("planned_days", remoteDay("new", "2026-10-27", { created_at: "2026-10-05T00:00:00Z", status: "done" }));
    await pullTables();
    const days = await db.planned_days.toArray();
    expect(days.map((d) => d.id)).toEqual(["new"]);
    expect(days[0].status).toBe("done");
  });

  it("a server row replaces the same-id local row (server is source of truth with an empty outbox)", async () => {
    await db.planned_days.put(localDay("d1", "2026-10-27", { status: "planned" }));
    put("planned_days", remoteDay("d1", "2026-10-27", { status: "skipped", skip_reason: "sick" }));
    await pullTables();
    expect(await db.planned_days.get("d1")).toMatchObject({ status: "skipped", skip_reason: "sick" });
  });

  it("moved_to / moved_from survive the pull as plain dates", async () => {
    put("planned_days", remoteDay("a", "2026-10-26", { status: "moved", moved_to: "2026-10-28T00:00:00+00:00" }));
    put("planned_days", remoteDay("b", "2026-10-28", { moved_from: "2026-10-26", was_marked: true }));
    await pullTables();
    expect(await db.planned_days.get("a")).toMatchObject({ status: "moved", moved_to: "2026-10-28" });
    expect(await db.planned_days.get("b")).toMatchObject({ moved_from: "2026-10-26", was_marked: true });
  });

  it("junk rows are skipped, good rows in the same table still apply", async () => {
    put("planned_days", { id: "bad1", date: "not-a-date" });
    put("planned_days", { id: 5 as never, date: "2026-10-30" });
    put("planned_days", remoteDay("good", "2026-10-29"));
    put("routines", { id: "r-bad" });
    put("routines", { id: "r-ok", name: "Push", created_at: "t" });
    put("measurements", { id: "m-bad", type: "weight", value: "abc", date: "2026-10-01" });
    put("measurements", { id: "m-ok", type: "weight", value: "80.5", date: "2026-10-02" });
    put("exercises", { id: "bench", name: "not custom", owner_id: UID });
    put("exercises", { id: "custom-ok", name: "Mine", owner_id: UID });
    await pullTables();
    expect((await db.planned_days.toArray()).map((d) => d.id)).toEqual(["good"]);
    expect((await db.routines.toArray()).map((r) => r.id)).toEqual(["r-ok"]);
    expect(await db.measurements.toArray()).toEqual([{ id: "m-ok", type: "weight", value: 80.5, date: "2026-10-02" }]);
    expect((await db.custom_exercises.toArray()).map((c) => c.id)).toEqual(["custom-ok"]);
  });

  it("empty server tables delete nothing local", async () => {
    await db.planned_days.put(localDay("keep", "2026-10-27"));
    await db.measurements.put({ id: "mkeep", type: "weight", value: 80, date: "2026-10-01" });
    await pullTables();
    expect(await db.planned_days.count()).toBe(1);
    expect(await db.measurements.count()).toBe(1);
  });

  it("running twice is idempotent", async () => {
    put("planned_days", remoteDay("a", "2026-10-27"));
    put("measurements", { id: "m", type: "weight", value: 80, date: "2026-10-01" });
    await pullTables();
    const first = JSON.stringify([await db.planned_days.toArray(), await db.measurements.toArray()]);
    await pullTables();
    expect(JSON.stringify([await db.planned_days.toArray(), await db.measurements.toArray()])).toBe(first);
  });

  it("two server measurements for one type and day are both kept without error", async () => {
    put("measurements", { id: "m1", type: "weight", value: 80, date: "2026-10-01" });
    put("measurements", { id: "m2", type: "weight", value: 81, date: "2026-10-01" });
    await expect(pullTables()).resolves.toBeUndefined();
    expect(await db.measurements.count()).toBeGreaterThanOrEqual(1);
  });

  it("two devices swapping the dates of two planned days does not abort the pull", async () => {
    // Local: A on 27th, B on 28th. Server (other device swapped them): A on 28th, B on 27th.
    await db.planned_days.bulkPut([localDay("A", "2026-10-27"), localDay("B", "2026-10-28")]);
    put("planned_days", remoteDay("A", "2026-10-28"));
    put("planned_days", remoteDay("B", "2026-10-27"));
    await expect(pullTables()).resolves.toBeUndefined();
    const days = Object.fromEntries((await db.planned_days.toArray()).map((d) => [d.id, d.date]));
    expect(days).toEqual({ A: "2026-10-28", B: "2026-10-27" });
  });

  it("a server row moving onto a date held by a different local row replaces it", async () => {
    await db.planned_days.bulkPut([localDay("A", "2026-10-27"), localDay("B", "2026-10-28")]);
    put("planned_days", remoteDay("A", "2026-10-28"));
    await expect(pullTables()).resolves.toBeUndefined();
    const days = await db.planned_days.toArray();
    expect(new Set(days.map((d) => d.date)).size).toBe(days.length);
    expect((await db.planned_days.get("A"))?.date).toBe("2026-10-28");
  });

  it("only this user's custom exercises are applied", async () => {
    put("exercises", { id: "custom-mine", name: "Mine", owner_id: UID });
    put("exercises", { id: "custom-theirs", name: "Theirs", owner_id: "someone-else" });
    await pullTables();
    expect((await db.custom_exercises.toArray()).map((c) => c.id)).toEqual(["custom-mine"]);
  });
});

describe("flush row mapping end to end", () => {
  it("a custom exercise upload cannot claim another owner", async () => {
    await db.outbox.add({ table: "exercises", op: "upsert", row: { id: "custom-1", name: "X", custom: true, owner_id: "attacker" }, created_at: "t" });
    await flush();
    expect(server.table("exercises").get("custom-1")).toEqual({ id: "custom-1", name: "X", owner_id: UID });
  });
});

describe("photoSync ordering", () => {
  it("never upserts a progress_photos row before its workout leaves the outbox", async () => {
    await db.workouts.put({ id: "w1", started_at: "t", ended_at: null, notes: null, routine_id: null });
    await db.outbox.add({ table: "workouts", op: "upsert", row: { id: "w1" }, created_at: "t" });
    await db.photos.put({ id: "p1", taken_at: "2026-10-01T09:00:00Z", pose: "front", blob: jpeg(), workout_id: "w1" } as never);
    await syncPhotos();
    expect(server.state.calls.filter((c) => c.includes("progress_photos") || c.startsWith("upload"))).toEqual([]);
    // The workout goes up: now the photo follows, with its link.
    await db.outbox.clear();
    expect((await syncPhotos()).uploaded).toBe(1);
    expect(server.table("progress_photos").get("p1")).toMatchObject({ workout_id: "w1" });
  });

  it("workout delete in the outbox does not block a photo; a photo for a pending workout does not block others", async () => {
    await db.workouts.put({ id: "w1", started_at: "t", ended_at: null, notes: null, routine_id: null });
    await db.outbox.bulkAdd([
      { table: "workouts", op: "upsert", row: { id: "w1" }, created_at: "t" },
      { table: "workouts", op: "delete", row: { id: "w2" }, created_at: "t" },
    ]);
    await db.photos.put({ id: "pA", taken_at: "t1", pose: "front", blob: jpeg(), workout_id: "w1" } as never);
    await db.photos.put({ id: "pB", taken_at: "t2", pose: "back", blob: jpeg() });
    await db.photos.put({ id: "pC", taken_at: "t3", pose: "side", blob: jpeg(), workout_id: "w2" } as never);
    expect((await syncPhotos()).uploaded).toBe(2);
    expect(server.table("progress_photos").has("pA")).toBe(false);
    expect(server.table("progress_photos").get("pC")).toMatchObject({ workout_id: null });
  });

  it("empty and oversized blobs are never uploaded", async () => {
    await db.photos.put({ id: "empty", taken_at: "t", pose: null, blob: new Blob([]) });
    await db.photos.put({ id: "huge", taken_at: "t", pose: null, blob: { size: MAX_PHOTO_BYTES + 1 } as never });
    expect((await syncPhotos()).uploaded).toBe(0);
    expect(server.state.calls.some((c) => c.startsWith("upload"))).toBe(false);
  });

  it("concurrent syncPhotos calls share one run (no double upload)", async () => {
    await db.photos.put({ id: "p1", taken_at: "t", pose: "front", blob: jpeg() });
    const [a, b] = await Promise.all([syncPhotos(), syncPhotos()]);
    expect(a).toBe(b);
    expect(server.state.calls.filter((c) => c.startsWith("upload"))).toHaveLength(1);
  });

  it("server rows with foreign, traversal or nested paths are never downloaded", async () => {
    for (const [id, path] of [["f1", "other/f1.jpg"], ["f2", `${UID}/../x.jpg`], ["f3", `${UID}/sub/f3.jpg`], ["f4", `${UID}\\f4.jpg`]]) {
      put("progress_photos", { id, taken_at: "2026-10-03T09:00:00Z", pose: "side", storage_path: path, workout_id: null });
    }
    await syncPhotos();
    expect(server.state.calls.filter((c) => c.startsWith("download"))).toEqual([]);
    expect(await db.photos.count()).toBe(0);
  });
});
