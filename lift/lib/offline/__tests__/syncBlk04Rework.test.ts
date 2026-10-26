import "fake-indexeddb/auto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// BLK-04 rework: dismissed letters stay protected, recorded deletes stop a
// re-send that would resurrect a deleted row, superseded letters are skipped,
// transient retry cap, owner re-check in pull, takeover meta/localStorage
// clearing, letter ids, corrupt meta. In-memory fake Supabase only.

type Row = Record<string, unknown>;

const server = vi.hoisted(() => {
  const state = {
    uid: "11111111-1111-4111-8111-111111111111",
    tables: new Map<string, Map<string, Record<string, unknown>>>(),
    calls: [] as string[],
    /** Error per row id; `times` errors are used up (absent = forever). */
    errors: new Map<string, { code?: string; message: string; status?: number; times?: number }>(),
    /** Runs once before a select of this table returns. */
    duringSelect: new Map<string, () => Promise<void>>(),
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
      if (err.times !== undefined && --err.times <= 0) state.errors.delete(id);
      const { status, times: _t, ...error } = err;
      void _t;
      return { error, status: status ?? 400 };
    }
    apply();
    return { error: null, status: 201 };
  };
  const query = (name: string): Record<string, unknown> => ({
    eq: () => query(name),
    gte: () => query(name),
    order: () => query(name),
    then: async (ok: (v: unknown) => unknown) => {
      const data = [...table(name).values()].map((r) => (name === "workouts" ? { ...r, workout_exercises: [] } : { ...r }));
      const hook = state.duringSelect.get(name);
      if (hook) {
        state.duringSelect.delete(name);
        await hook();
      }
      return ok({ data, error: null });
    },
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
const storage = new Map<string, string>();
vi.stubGlobal("navigator", net);
vi.stubGlobal("window", win);
vi.stubGlobal("localStorage", {
  get length() {
    return storage.size;
  },
  key: (i: number) => [...storage.keys()][i] ?? null,
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

const { db } = await import("../db");
const sync = await import("../sync");
const {
  flush,
  pull,
  pullTables,
  enqueue,
  deadLetters,
  retryDeadLetters,
  resendDeadLetters,
  dismissDeadLetters,
  dismissedCount,
  deadLetterKey,
  deleteWorkout,
  validDeadLetters,
  DEAD_LETTER_KEY,
  DISMISSED_KEY,
  RECENT_DELETES_KEY,
  MAX_TRANSIENT_RETRIES,
} = sync;
const owner = await import("../owner");
const { obsoleteDeadLetters } = await import("../remote");
const { deleteMeasurement } = await import("../../measurements");

afterAll(() => vi.unstubAllGlobals());

const UID = server.state.uid;
const OTHER = "22222222-2222-4222-8222-222222222222";
const idle = () => new Promise((r) => setTimeout(r, 0));
const q = (table: string, op: "upsert" | "delete", row: Row) => ({ table, op, row, created_at: "t" }) as never;
const letter = (table: string, row: Row, extra: Row = {}) => ({ table, op: "upsert", row, code: "23503", message: "fk", at: "t", tries: 1, ...extra });
const setLetters = (list: unknown[]) => db.meta.put({ key: DEAD_LETTER_KEY, value: list });
const w = (id: string) => ({ id, started_at: "2026-10-01T08:00:00.000Z", ended_at: "2026-10-01T09:00:00.000Z", notes: null, routine_id: null });

beforeEach(async () => {
  for (let i = 0; i < 3; i++) await idle();
  server.state.tables.clear();
  server.state.calls.length = 0;
  server.state.errors.clear();
  server.state.duringSelect.clear();
  server.state.uid = UID;
  net.onLine = false;
  storage.clear();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("dismissed letters stay protected", () => {
  it("pull after Dismiss keeps the never-uploaded workout", async () => {
    await db.workouts.put(w("w1"));
    await db.workout_exercises.put({ id: "we1", workout_id: "w1", exercise_id: "Bench", position: 0 });
    await setLetters([letter("workouts", { id: "w1" }), letter("sets", { id: "s1", workout_exercise_id: "we1" }, { at: "t2" })]);
    expect(await dismissDeadLetters()).toBe(2);
    expect(await deadLetters()).toEqual([]);
    expect(await dismissedCount()).toBe(2);
    net.onLine = true;
    await pull(3650);
    expect(await db.workouts.get("w1")).toBeTruthy();
  });

  it("protected through a set letter only (the workout row itself synced)", async () => {
    await db.workouts.put(w("w2"));
    await db.workout_exercises.put({ id: "we2", workout_id: "w2", exercise_id: "Bench", position: 0 });
    await setLetters([letter("sets", { id: "s2", workout_exercise_id: "we2" })]);
    await dismissDeadLetters();
    net.onLine = true;
    await pull(3650);
    expect(await db.workouts.get("w2")).toBeTruthy();
  });

  it("dismissed rows block an account takeover", async () => {
    await db.meta.put({ key: owner.OWNER_KEY, value: OTHER });
    await db.workouts.put(w("w1"));
    await setLetters([letter("workouts", { id: "w1" })]);
    await dismissDeadLetters();
    expect(await owner.claimOwner(UID)).toBe(false);
    expect(await db.workouts.get("w1")).toBeTruthy();
  });

  it("deleting the workout releases the protection, and the takeover can go ahead", async () => {
    await db.workouts.put(w("w1"));
    await setLetters([letter("workouts", { id: "w1" })]);
    await dismissDeadLetters();
    await deleteWorkout("w1");
    await vi.waitFor(async () => expect(await dismissedCount()).toBe(0));
    await db.outbox.clear();
    await db.meta.put({ key: owner.OWNER_KEY, value: OTHER });
    expect(await owner.claimOwner(UID)).toBe(true);
  });

  it("dismissed entries keep ids only", async () => {
    await setLetters([letter("measurements", { id: "m1", value: 80, secret: "x" })]);
    await dismissDeadLetters();
    expect((await db.meta.get(DISMISSED_KEY))?.value).toEqual([{ table: "measurements", op: "upsert", row: { id: "m1" } }]);
  });
});

describe("recorded deletes stop a resurrecting re-send", () => {
  it("letter for a row deleted on this device (delete already sent) is dropped by retry, outbox stays empty", async () => {
    await db.measurements.put({ id: "m1", type: "body_weight", value: 80, date: "2026-10-20" });
    await deleteMeasurement("m1");
    net.onLine = true;
    await flush();
    expect(await db.outbox.count()).toBe(0);
    expect(((await db.meta.get(RECENT_DELETES_KEY))?.value as Row[]).map((d) => (d.row as Row).id)).toContain("m1");
    // The letter comes back afterwards (e.g. the drop never ran because the app closed).
    net.onLine = false;
    await setLetters([letter("measurements", { id: "m1" })]);
    expect(await retryDeadLetters()).toBe(0);
    expect(await deadLetters()).toEqual([]);
    expect(await db.outbox.count()).toBe(0);
  });

  it("children of a deleted parent are dropped by resend too", async () => {
    await db.meta.put({ key: RECENT_DELETES_KEY, value: [{ table: "routines", op: "delete", row: { id: "r1" } }] });
    await setLetters([letter("routine_exercises", { id: "re1", routine_id: "r1" }), letter("measurements", { id: "m9" }, { at: "t2" })]);
    expect(await resendDeadLetters()).toBe(1);
    expect((await db.outbox.toArray()).map((i) => i.row.id)).toEqual(["m9"]);
  });

  it("a letter with a recorded delete but a local row (re-created) is still re-sent", async () => {
    await db.meta.put({ key: RECENT_DELETES_KEY, value: [{ table: "measurements", op: "delete", row: { id: "m1" } }] });
    await db.measurements.put({ id: "m1", type: "body_weight", value: 80, date: "2026-10-20" });
    await setLetters([letter("measurements", { id: "m1" })]);
    expect(await retryDeadLetters()).toBe(1);
  });

  it("a letter with no local row and no recorded delete is still re-sent (only the outbox had it)", async () => {
    await setLetters([letter("measurements", { id: "m1" })]);
    expect(await retryDeadLetters()).toBe(1);
  });
});

describe("dead-lettering", () => {
  it("a letter superseded by a newer write queued while it was in flight is not kept", async () => {
    net.onLine = true;
    server.state.errors.set("m1", { code: "23505", message: "dup", times: 1 });
    await db.outbox.bulkAdd([q("measurements", "upsert", { id: "m1", value: 1 }), q("measurements", "upsert", { id: "m1", value: 2 })]);
    await flush();
    expect(await deadLetters()).toEqual([]);
    expect(server.table("measurements").get("m1")).toMatchObject({ value: 2 });
  });

  it("two letters made in the same pass get distinct keys", async () => {
    net.onLine = true;
    server.state.errors.set("w1", { code: "23503", message: "fk" });
    await db.outbox.bulkAdd([q("workouts", "upsert", { id: "w1" }), q("workout_exercises", "upsert", { id: "w1", workout_id: "w1" })]);
    await flush();
    const list = await deadLetters();
    expect(list).toHaveLength(2);
    expect(new Set(list.map(deadLetterKey)).size).toBe(2);
    expect(list.every((d) => typeof d.id === "string" && d.id.length > 0)).toBe(true);
  });

  it("transient server errors are dead-lettered after MAX_TRANSIENT_RETRIES, with the HTTP status as code", async () => {
    net.onLine = true;
    server.state.errors.set("m1", { code: "", message: "Bad gateway", status: 502 });
    await db.outbox.add(q("measurements", "upsert", { id: "m1" }));
    for (let i = 0; i < MAX_TRANSIENT_RETRIES - 1; i++) await flush();
    expect(await deadLetters()).toEqual([]);
    await flush();
    expect(await deadLetters()).toMatchObject([{ row: { id: "m1" }, code: "HTTP 502" }]);
    expect(await db.outbox.count()).toBe(0);
  });

  it("deleteWorkout drops the letters in its own transaction (rolled back together)", async () => {
    await db.workouts.put(w("w1"));
    await setLetters([letter("workouts", { id: "w1" })]);
    const spy = vi.spyOn(db.outbox, "bulkAdd").mockRejectedValueOnce(new Error("disk full"));
    await expect(deleteWorkout("w1")).rejects.toThrow();
    spy.mockRestore();
    expect(await db.workouts.get("w1")).toBeTruthy();
    expect(await deadLetters()).toHaveLength(1);
  });

  it("an enqueue inside a transaction that aborts drops no letters", async () => {
    await setLetters([letter("measurements", { id: "m1" })]);
    await expect(
      db.transaction("rw", [db.measurements, db.outbox], async () => {
        await enqueue([{ table: "measurements", op: "delete", row: { id: "m1" } }]);
        throw new Error("abort");
      }),
    ).rejects.toThrow();
    for (let i = 0; i < 5; i++) await idle();
    expect(await deadLetters()).toHaveLength(1);
  });
});

describe("pull re-checks the owner", () => {
  it("pull applies nothing when another account took the device over during the request", async () => {
    net.onLine = true;
    await db.workouts.put(w("old"));
    server.state.duringSelect.set("workouts", async () => {
      await db.meta.put({ key: owner.OWNER_KEY, value: OTHER });
    });
    await pull(3650);
    expect(await db.workouts.get("old")).toBeTruthy();
  });

  it("pullTables applies nothing when the owner changed during the request", async () => {
    net.onLine = true;
    await owner.claimOwner(UID);
    server.table("measurements").set("m1", { id: "m1", type: "body_weight", value: 80, date: "2026-10-20" });
    server.state.duringSelect.set("measurements", async () => {
      await db.meta.put({ key: owner.OWNER_KEY, value: OTHER });
    });
    await pullTables();
    expect(await db.measurements.get("m1")).toBeUndefined();
  });
});

describe("takeover", () => {
  it("clears account meta, account prefixes and the app's localStorage except the theme", async () => {
    await db.meta.put({ key: owner.OWNER_KEY, value: OTHER });
    await db.meta.bulkPut([
      { key: "goals", value: {} },
      { key: "split", value: {} },
      { key: "renames", value: {} },
      { key: "favorites", value: [] },
      { key: "plateau_dismissed", value: [] },
      { key: "plateau_fix_applied", value: {} },
      { key: "photo_analysis:2026-10", value: {} },
      { key: "evidence-picks:x|y|Chest", value: {} },
      { key: "settings", value: { unit: "kg" } },
      { key: "reminders", value: {} },
      { key: "equipment", value: [] },
      { key: "today_picks_per_muscle", value: 2 },
      { key: "rest:Bench", value: 120 },
    ]);
    storage.set("lift:rest", "{}");
    storage.set("lift-theme", "dark");
    expect(await owner.claimOwner(UID)).toBe(true);
    const left = (await db.meta.toArray()).map((m) => m.key).sort();
    expect(left).toEqual(["equipment", "reminders", "rest:Bench", "settings", "sync:owner", "today_picks_per_muscle"]);
    expect(storage.has("lift:rest")).toBe(false);
    expect(storage.get("lift-theme")).toBe("dark");
  });

  it("the owner itself never touches localStorage", async () => {
    await owner.claimOwner(UID);
    storage.set("lift:rest", "{}");
    expect(await owner.claimOwner(UID)).toBe(true);
    expect(storage.has("lift:rest")).toBe(true);
  });

  it("owner.ts literal keys match sync.ts", () => {
    expect(owner.DISMISSED_KEY).toBe(DISMISSED_KEY);
    expect(owner.RECENT_DELETES_KEY).toBe(RECENT_DELETES_KEY);
  });
});

describe("corrupt dead-letter meta", () => {
  it("dismiss and resend tolerate null, numbers and row-less entries, and clean them up", async () => {
    await setLetters([null, 5, { table: "measurements", op: "upsert" }, letter("measurements", { id: "ok" })]);
    expect(await dismissDeadLetters(["x"])).toBe(0);
    expect((await db.meta.get(DEAD_LETTER_KEY))?.value).toHaveLength(1);
    expect(await resendDeadLetters()).toBe(1);
  });

  it("validDeadLetters keeps any object with a row and drops the rest", () => {
    expect(validDeadLetters([null, 5, "x", {}, { row: null }, { row: { id: "a" } }])).toEqual([{ row: { id: "a" } }]);
    expect(validDeadLetters("oops")).toEqual([]);
  });

  it("obsoleteDeadLetters and deadLetterKey never throw on junk", () => {
    expect(() => obsoleteDeadLetters([null, { table: "sets" }] as never, [null, { table: "workouts", op: "delete" }] as never)).not.toThrow();
    expect(deadLetterKey(null as never)).toBe("");
  });
});

describe("every meta key the app writes is classified", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
    }
  };
  for (const d of ["lib", "components", "app"]) walk(join(ROOT, d));

  /** Key expressions that are not a plain identifier or string literal. */
  const SPECIAL: Record<string, string[]> = {
    "exerciseId ? `rest:${exerciseId}` : \"default_rest_sec\"": ["rest:*", "default_rest_sec"],
    "cacheKey(goals.goalType": ["evidence-picks:*"],
    "analysisKey(month)": ["photo_analysis:*"],
  };

  it("finds the writes and classifies each key as account data or device preference", () => {
    const found: { file: string; key: string }[] = [];
    const unknown: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/db\.meta\.put\(\{\s*key:\s*([^,]+?),/g)) {
        const expr = m[1].trim();
        const rel = relative(ROOT, f).replace(/\\/g, "/");
        if (SPECIAL[expr]) {
          for (const k of SPECIAL[expr]) found.push({ file: rel, key: k });
          continue;
        }
        const lit = /^"([^"]+)"$/.exec(expr);
        if (lit) {
          found.push({ file: rel, key: lit[1] });
          continue;
        }
        const def = new RegExp(`const ${expr} = "([^"]+)"`).exec(src);
        if (/^[A-Z_]+$/.test(expr) && def) found.push({ file: rel, key: def[1] });
        else unknown.push(`${rel}: ${expr}`);
      }
    }
    expect(unknown).toEqual([]);
    expect(found.length).toBeGreaterThan(20);
    const account = new Set<string>(owner.ACCOUNT_META_KEYS);
    const device = new Set<string>(owner.DEVICE_META_KEYS);
    const unclassified = found.filter(({ key }) => {
      if (key.endsWith("*")) {
        const p = key.slice(0, -1);
        return !(owner.ACCOUNT_META_PREFIXES as readonly string[]).includes(p) && !(owner.DEVICE_META_PREFIXES as readonly string[]).includes(p);
      }
      return !account.has(key) && !device.has(key);
    });
    expect(unclassified).toEqual([]);
    // No key is both.
    for (const k of account) expect(device.has(k)).toBe(false);
  });
});
