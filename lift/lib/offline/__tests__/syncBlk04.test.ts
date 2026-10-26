import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// BLK-04: sync hardening follow-ups from the BLK-02 review. Dead letters are
// dropped with their rows, retry skips superseded letters, owner takeover
// clears the previous account's rows, transient 5xx never dead-letter, the
// Profile > Sync resend/dismiss API, the erase helper and atomic Lyfta import.
// In-memory fake Supabase only; no live service is touched.

type Row = Record<string, unknown>;

const server = vi.hoisted(() => {
  const state = {
    uid: "11111111-1111-4111-8111-111111111111",
    tables: new Map<string, Map<string, Record<string, unknown>>>(),
    calls: [] as string[],
    errors: new Map<string, { code?: string; message: string; status?: number }>(),
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
      const { status, ...error } = err;
      return { error, status: status ?? 400 };
    }
    apply();
    return { error: null, status: 201 };
  };
  const query = (name: string): Record<string, unknown> => ({
    eq: () => query(name),
    gte: () => query(name),
    order: () => query(name),
    then: (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: [...table(name).values()].map((r) => (name === "workouts" ? { ...r, workout_exercises: [] } : { ...r })), error: null }).then(ok),
  });
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: state.uid } } } }),
      signOut: async () => ({ error: null }),
    },
    from: (name: string) => ({
      select: () => query(name),
      upsert: async (row: Record<string, unknown>) => write(name, "upsert", row, () => table(name).set(row.id as string, { ...row })),
      delete: () => ({ eq: async (_c: string, id: string) => write(name, "delete", { id }, () => table(name).delete(id)) }),
    }),
  };
  return { state, table, client };
});

vi.mock("@/lib/supabase/configured", () => ({ supabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: () => server.client }));

const net = { onLine: false };
const win = new EventTarget();
vi.stubGlobal("navigator", net);
vi.stubGlobal("window", win);

const { db } = await import("../db");
const sync = await import("../sync");
const { flush, deadLetters, retryDeadLetters, resendDeadLetters, dismissDeadLetters, deadLetterKey, deleteWorkout, DEAD_LETTER_KEY, MAX_CODED_RETRIES, MAX_DEAD_LETTER_TRIES } = sync;
const owner = await import("../owner");
const { obsoleteDeadLetters, isTransientServerError, splitPlannedDays, plannedDayFromRemote } = await import("../remote");
const { deleteRoutine } = await import("../../routines");
const { deleteCustomExercise } = await import("../../customExercises");
const { clearDay } = await import("../../planner");
const { deleteMeasurement } = await import("../../measurements");
const { runImport } = await import("../../lyfta/run");

afterAll(() => vi.unstubAllGlobals());

const UID = server.state.uid;
const OTHER = "22222222-2222-4222-8222-222222222222";
const idle = () => new Promise((r) => setTimeout(r, 0));
const q = (table: string, op: "upsert" | "delete", row: Row) => ({ table, op, row, created_at: "t" }) as never;
const letter = (table: string, row: Row, extra: Row = {}) => ({ table, op: "upsert", row, code: "23503", message: "fk", at: "t", tries: 1, ...extra });
const setLetters = (list: Row[]) => db.meta.put({ key: DEAD_LETTER_KEY, value: list });
const letterIds = async () => (await deadLetters()).map((d) => `${d.table}:${String(d.row.id)}`);
const w = (id: string) => ({ id, started_at: "2026-10-01T08:00:00.000Z", ended_at: "2026-10-01T09:00:00.000Z", notes: null, routine_id: null });

beforeEach(async () => {
  for (let i = 0; i < 3; i++) await idle();
  server.state.tables.clear();
  server.state.calls.length = 0;
  server.state.errors.clear();
  server.state.uid = UID;
  net.onLine = false;
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("obsoleteDeadLetters (pure)", () => {
  const L = (table: string, row: Row) => ({ table, op: "upsert", row }) as never as { table: "sets"; op: "upsert"; row: Row };

  it("a newer upsert or delete of the same row id supersedes the letter", () => {
    const a = L("measurements", { id: "m1" });
    const b = L("measurements", { id: "m2" });
    expect([...obsoleteDeadLetters([a, b], [q("measurements", "upsert", { id: "m1" })])]).toEqual([a]);
    expect([...obsoleteDeadLetters([a, b], [q("measurements", "delete", { id: "m2" })])]).toEqual([b]);
    // Same id in another table is not the same row.
    expect(obsoleteDeadLetters([a], [q("routines", "delete", { id: "m1" })]).size).toBe(0);
  });

  it("a deleted workout takes its exercises, their sets and records along", () => {
    const we = L("workout_exercises", { id: "we1", workout_id: "w1" });
    const s = L("sets", { id: "s1", workout_exercise_id: "we1" });
    const pr = L("personal_records", { id: "pr1", set_id: "s1" });
    const other = L("sets", { id: "s9", workout_exercise_id: "we9" });
    const gone = obsoleteDeadLetters([we, s, pr, other], [q("workouts", "delete", { id: "w1" })]);
    expect([...gone]).toEqual([we, s, pr]);
  });

  it("known local children cover sets whose exercise synced fine", () => {
    const s = L("sets", { id: "s1", workout_exercise_id: "weLocal" });
    expect(obsoleteDeadLetters([s], [q("workouts", "delete", { id: "w1" })]).size).toBe(0);
    expect(obsoleteDeadLetters([s], [q("workouts", "delete", { id: "w1" })], { workoutExerciseIds: ["weLocal"] }).size).toBe(1);
    const pr = L("personal_records", { id: "pr", set_id: "sLocal" });
    expect(obsoleteDeadLetters([pr], [q("workouts", "delete", { id: "w1" })], { setIds: ["sLocal"] }).size).toBe(1);
  });

  it("a deleted routine takes its exercises along", () => {
    const re = L("routine_exercises", { id: "re1", routine_id: "r1" });
    const keep = L("routine_exercises", { id: "re2", routine_id: "r2" });
    expect([...obsoleteDeadLetters([re, keep], [q("routines", "delete", { id: "r1" })])]).toEqual([re]);
  });
});

describe("isTransientServerError (pure)", () => {
  it("5xx, connection, resource, timeout and PostgREST connection errors are transient", () => {
    for (const code of ["08006", "53300", "57014", "58030", "40001", "40P01", "PGRST000", "PGRST003"]) expect(isTransientServerError({ code })).toBe(true);
    expect(isTransientServerError({ code: "42501" }, 503)).toBe(true);
  });

  it("row-level security, auth and integrity errors are not", () => {
    for (const code of ["42501", "PGRST301", "23503", "42703", "", "PGRST204"]) expect(isTransientServerError({ code }, 400)).toBe(false);
    expect(isTransientServerError(null)).toBe(false);
  });
});

describe("planned-day dedupe with two different workout links", () => {
  it("the winner keeps its own link, the loser is deleted, no relink upload (documented in splitPlannedDays)", () => {
    const day = (id: string, extra: Row) =>
      plannedDayFromRemote({ id, date: "2026-10-20", status: "done", created_at: "2026-10-20T00:00:00Z", ...extra })!;
    const a = day("a", { workout_id: "wA", created_at: "2026-10-20T01:00:00Z" });
    const b = day("b", { workout_id: "wB" });
    const { keep, losers, relinked } = splitPlannedDays([a, b]);
    expect(keep).toEqual([a]);
    expect(losers).toEqual([b]);
    expect(relinked).toEqual([]);
  });
});

describe("deleting an entity drops its dead letters", () => {
  it("workout: its own, its exercises', sets' and records' letters (incl. sets of exercises that synced)", async () => {
    await db.workouts.put(w("w1"));
    await db.workout_exercises.put({ id: "weOk", workout_id: "w1", exercise_id: "Bench", position: 0 });
    await db.sets.put({ id: "s1", workout_exercise_id: "weOk", set_no: 1, reps: 5, weight: 100, is_warmup: false, rir: null, completed_at: "t" });
    await setLetters([
      letter("workouts", { id: "w1" }),
      letter("workout_exercises", { id: "weBad", workout_id: "w1" }),
      letter("sets", { id: "s1", workout_exercise_id: "weOk" }),
      letter("sets", { id: "s2", workout_exercise_id: "weBad" }),
      letter("personal_records", { id: "pr1", set_id: "s1" }),
      letter("workouts", { id: "w2" }),
    ]);
    await deleteWorkout("w1");
    await vi.waitFor(async () => expect(await letterIds()).toEqual(["workouts:w2"]));
  });

  it("routine: its own and its exercises' letters", async () => {
    await db.routines.put({ id: "r1", name: "Push", day_label: null, source: "manual", kind: "routine", source_url: null, platform: null, thumbnail_url: null, creator: null, notes: null, created_at: "t" });
    await setLetters([letter("routines", { id: "r1" }), letter("routine_exercises", { id: "re1", routine_id: "r1" }), letter("routines", { id: "r2" })]);
    await deleteRoutine("r1");
    await vi.waitFor(async () => expect(await letterIds()).toEqual(["routines:r2"]));
  });

  it("custom exercise, planned day and measurement", async () => {
    await db.planned_days.put({ id: "d1", date: "2026-10-20", routine_id: null, status: "planned", workout_id: null, skip_reason: null, skip_note: null, moved_to: null, moved_from: null, created_at: "t" });
    await db.measurements.put({ id: "m1", type: "body_weight", value: 80, date: "2026-10-20" });
    await setLetters([
      letter("exercises", { id: "custom-1" }),
      letter("planned_days", { id: "d1" }),
      letter("measurements", { id: "m1" }),
      letter("measurements", { id: "m2" }),
    ]);
    await deleteCustomExercise("custom-1");
    await clearDay("2026-10-20");
    await deleteMeasurement("m1");
    await vi.waitFor(async () => expect(await letterIds()).toEqual(["measurements:m2"]));
  });

  it("a delete written straight into the outbox drops the letters once flush sends it", async () => {
    await setLetters([letter("planned_days", { id: "d1" }), letter("planned_days", { id: "d2" })]);
    await db.outbox.add(q("planned_days", "delete", { id: "d1" }));
    net.onLine = true;
    await flush();
    expect(await letterIds()).toEqual(["planned_days:d2"]);
  });
});

describe("retryDeadLetters skips superseded letters", () => {
  it("a newer queued delete or upsert of the same row, or a queued delete of its parent, wins", async () => {
    await setLetters([
      letter("measurements", { id: "m1" }),
      letter("measurements", { id: "m2" }),
      letter("routine_exercises", { id: "re1", routine_id: "r1" }),
      letter("measurements", { id: "m3" }),
    ]);
    await db.outbox.bulkAdd([q("measurements", "delete", { id: "m1" }), q("measurements", "upsert", { id: "m2", value: 81 }), q("routines", "delete", { id: "r1" })]);
    expect(await retryDeadLetters()).toBe(1);
    const queued = (await db.outbox.orderBy("seq").toArray()).map((i) => `${i.op} ${i.table} ${String(i.row.id)}`);
    expect(queued).toEqual(["delete measurements m1", "upsert measurements m2", "delete routines r1", "upsert measurements m3"]);
    expect(await deadLetters()).toEqual([]);
  });

  it("superseded letters past the try cap are dropped too", async () => {
    await setLetters([letter("measurements", { id: "m1" }, { tries: MAX_DEAD_LETTER_TRIES })]);
    await db.outbox.add(q("measurements", "delete", { id: "m1" }));
    expect(await retryDeadLetters()).toBe(0);
    expect(await deadLetters()).toEqual([]);
  });
});

describe("coded retry cap", () => {
  it("transient server errors (5xx / timeouts) are never dead-lettered", async () => {
    net.onLine = true;
    server.state.errors.set("m1", { code: "57014", message: "statement timeout" });
    server.state.errors.set("m2", { code: "", message: "Bad gateway", status: 502 });
    await db.outbox.add(q("measurements", "upsert", { id: "m1" }));
    for (let i = 0; i < MAX_CODED_RETRIES + 3; i++) await flush();
    expect(await deadLetters()).toEqual([]);
    expect(await db.outbox.count()).toBe(1);
    server.state.errors.set("m1", { code: "XX999", message: "odd", status: 503 });
    for (let i = 0; i < MAX_CODED_RETRIES + 3; i++) await flush();
    expect(await deadLetters()).toEqual([]);
    server.state.errors.delete("m1");
    expect(await flush()).toBe(1);
  });
});

describe("Profile > Sync: resend and dismiss", () => {
  it("dismiss one by key, then all; local rows are untouched", async () => {
    await db.measurements.put({ id: "m1", type: "body_weight", value: 80, date: "2026-10-20" });
    const a = letter("measurements", { id: "m1" }, { tries: MAX_DEAD_LETTER_TRIES });
    const b = letter("measurements", { id: "m2" }, { at: "t2" });
    await setLetters([a, b]);
    expect(await dismissDeadLetters([deadLetterKey(a as never)])).toBe(1);
    expect(await letterIds()).toEqual(["measurements:m2"]);
    expect(await dismissDeadLetters()).toBe(1);
    expect(await deadLetters()).toEqual([]);
    expect(await db.measurements.get("m1")).toBeTruthy();
  });

  it("resend queues the chosen letter even past the try cap and keeps its tries count", async () => {
    const a = letter("measurements", { id: "m1" }, { tries: MAX_DEAD_LETTER_TRIES });
    const b = letter("measurements", { id: "m2" }, { at: "t2" });
    await setLetters([a, b]);
    expect(await resendDeadLetters([deadLetterKey(a as never)])).toBe(1);
    expect(await letterIds()).toEqual(["measurements:m2"]);
    expect(await db.outbox.toArray()).toMatchObject([{ table: "measurements", op: "upsert", row: { id: "m1" }, retries: MAX_DEAD_LETTER_TRIES }]);
    net.onLine = true;
    expect(await flush()).toBe(1);
    expect(server.table("measurements").has("m1")).toBe(true);
  });

  it("resend all keeps the original order; a superseded letter is dropped, not sent", async () => {
    await setLetters([letter("workouts", { id: "w1" }), letter("workout_exercises", { id: "we1", workout_id: "w1" }, { at: "t2" }), letter("measurements", { id: "m9" })]);
    await db.outbox.add(q("measurements", "delete", { id: "m9" }));
    expect(await resendDeadLetters()).toBe(2);
    expect((await db.outbox.orderBy("seq").toArray()).map((i) => `${i.table} ${String(i.row.id)}`)).toEqual(["measurements m9", "workouts w1", "workout_exercises we1"]);
    expect(await deadLetters()).toEqual([]);
  });

  it("an unknown key changes nothing", async () => {
    await setLetters([letter("measurements", { id: "m1" })]);
    expect(await resendDeadLetters(["nope"])).toBe(0);
    expect(await dismissDeadLetters(["nope"])).toBe(0);
    expect(await letterIds()).toEqual(["measurements:m1"]);
  });
});

describe("owner takeover", () => {
  async function seedPreviousAccount() {
    await db.meta.put({ key: owner.OWNER_KEY, value: OTHER });
    await db.workouts.put(w("wA"));
    await db.workout_exercises.put({ id: "weA", workout_id: "wA", exercise_id: "Bench", position: 0 });
    await db.sets.put({ id: "sA", workout_exercise_id: "weA", set_no: 1, reps: 5, weight: 100, is_warmup: false, rir: null, completed_at: "t" });
    await db.measurements.put({ id: "mA", type: "body_weight", value: 80, date: "2026-10-20" });
    await db.routines.put({ id: "rA", name: "Push", day_label: null, source: "manual", kind: "routine", source_url: null, platform: null, thumbnail_url: null, creator: null, notes: null, created_at: "t" });
    await db.routine_exercises.put({ id: "reA", routine_id: "rA", exercise_id: "Bench", position: 0, target_sets: 3, target_reps: "8-12" });
    await db.planned_days.put({ id: "dA", date: "2026-10-20", routine_id: "rA", status: "planned", workout_id: null, skip_reason: null, skip_note: null, moved_to: null, moved_from: null, created_at: "t" });
    await db.custom_exercises.put({ id: "custom-A", name: "Mine", muscle_groups: [], secondary_groups: [], equipment: "Other", category: "strength", mechanic: null, force: null, level: "beginner", instructions: [], image_urls: [], tiktok_url: "", custom: true });
    await db.meta.bulkPut([
      { key: "profile", value: { name: "A", email: "a@example.com" } },
      { key: "lyfta_key", value: "secret" },
      { key: "lastPull", value: "t" },
      { key: "settings", value: { unit: "lb" } },
      { key: "default_rest_sec", value: 120 },
    ]);
  }

  it("another account taking over clears the previous account's synced rows, keeps device settings", async () => {
    await seedPreviousAccount();
    const seen: string[] = [];
    const on = () => seen.push("ok");
    win.addEventListener(owner.OWNER_OK_EVENT, on);
    expect(await owner.claimOwner(UID)).toBe(true);
    win.removeEventListener(owner.OWNER_OK_EVENT, on);
    expect(seen).toEqual(["ok"]);
    expect(await owner.getOwner()).toBe(UID);
    for (const t of [db.workouts, db.workout_exercises, db.sets, db.measurements, db.routines, db.routine_exercises, db.planned_days, db.custom_exercises]) {
      expect(await t.count()).toBe(0);
    }
    for (const k of ["profile", "lyfta_key", "lastPull"]) expect(await db.meta.get(k)).toBeUndefined();
    expect((await db.meta.get("settings"))?.value).toEqual({ unit: "lb" });
    expect((await db.meta.get("default_rest_sec"))?.value).toBe(120);
  });

  it("a refused takeover (unsent changes) clears nothing and fires the mismatch event", async () => {
    await seedPreviousAccount();
    await db.outbox.add(q("measurements", "upsert", { id: "mA" }));
    const seen: string[] = [];
    const bad = () => seen.push("mismatch");
    win.addEventListener(owner.OWNER_MISMATCH_EVENT, bad);
    expect(await owner.claimOwner(UID)).toBe(false);
    win.removeEventListener(owner.OWNER_MISMATCH_EVENT, bad);
    expect(seen).toEqual(["mismatch"]);
    expect(await db.workouts.count()).toBe(1);
    expect((await db.meta.get("profile"))?.value).toBeTruthy();
  });

  it("the owner itself and a first claim never clear anything, and fire the ok event", async () => {
    await db.workouts.put(w("w1"));
    const seen: string[] = [];
    const on = () => seen.push("ok");
    win.addEventListener(owner.OWNER_OK_EVENT, on);
    expect(await owner.claimOwner(UID)).toBe(true);
    expect(await owner.claimOwner(UID)).toBe(true);
    win.removeEventListener(owner.OWNER_OK_EVENT, on);
    expect(seen).toEqual(["ok", "ok"]);
    expect(await db.workouts.count()).toBe(1);
  });

  it("ACCOUNT_META_KEYS match the sync and photo meta keys", async () => {
    const photo = await import("../photoSync");
    for (const k of [DEAD_LETTER_KEY, photo.SYNCED_KEY, photo.DELETED_KEY, photo.FAILS_KEY]) expect(owner.ACCOUNT_META_KEYS).toContain(k);
  });
});

describe("clearAppLocalStorage", () => {
  function store(init: Record<string, string>) {
    const m = new Map(Object.entries(init));
    return {
      get length() {
        return m.size;
      },
      key: (i: number) => [...m.keys()][i] ?? null,
      removeItem: (k: string) => void m.delete(k),
      map: m,
    };
  }

  it("removes the app's keys and prefixed keys, leaves others", () => {
    const s = store({ "lift:rest": "{}", "lift-theme": "dark", "lift:other": "1", "sb-abc-auth-token": "x", unrelated: "y" });
    owner.clearAppLocalStorage(s);
    expect([...s.map.keys()].sort()).toEqual(["sb-abc-auth-token", "unrelated"]);
  });

  it("never throws without storage or when storage throws", () => {
    expect(owner.clearAppLocalStorage(undefined)).toBe(0);
    const broken = { length: 1, key: () => { throw new Error("denied"); }, removeItem: () => {} };
    expect(owner.clearAppLocalStorage(broken)).toBe(0);
  });
});

describe("Lyfta import queues atomically", () => {
  const workouts = [
    {
      id: 5001,
      title: "Upper",
      workout_perform_date: "2026-08-20T17:05:00.000Z",
      exercises: [{ exercise_id: 2, excercise_name: "Bench Press", sets: [{ id: "s1", weight: "80", reps: "5", is_completed: true }] }],
    },
  ];
  const plan = [{ lyfta_id: "2", name: "Bench Press", sets: 1, confidence: "saved" as const, candidates: [], choice: { kind: "catalogue" as const, id: "Bench_Press" } }];

  it("writes the workout and queues it in one transaction", async () => {
    const r = await runImport(workouts as never, plan as never, "kg");
    expect(r.imported).toBe(1);
    const queued = await db.outbox.toArray();
    expect(queued.map((i) => i.table)).toEqual(["workouts", "workout_exercises", "sets"]);
    expect(await db.workouts.count()).toBe(1);
  });

  it("if queueing fails nothing is written, so a pull can never see an unqueued import", async () => {
    const spy = vi.spyOn(db.outbox, "bulkAdd").mockRejectedValueOnce(new Error("disk full"));
    await expect(runImport(workouts as never, plan as never, "kg")).rejects.toThrow();
    spy.mockRestore();
    expect(await db.workouts.count()).toBe(0);
    expect(await db.sets.count()).toBe(0);
  });
});
