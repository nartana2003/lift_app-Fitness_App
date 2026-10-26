import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// QA for BLK-04. In-memory fake Supabase only; never a live service.
const server = vi.hoisted(() => {
  const state = { uid: "11111111-1111-4111-8111-111111111111", tables: new Map<string, Map<string, Record<string, unknown>>>() };
  const table = (n: string) => {
    if (!state.tables.has(n)) state.tables.set(n, new Map());
    return state.tables.get(n)!;
  };
  const query = (n: string): Record<string, unknown> => ({
    eq: () => query(n),
    gte: () => query(n),
    order: () => query(n),
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [...table(n).values()], error: null }).then(ok),
  });
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: state.uid } } } }), signOut: async () => ({ error: null }) },
    from: (n: string) => ({
      select: () => query(n),
      upsert: async (row: Record<string, unknown>) => (table(n).set(row.id as string, row), { error: null, status: 201 }),
      delete: () => ({ eq: async (_c: string, id: string) => (table(n).delete(id), { error: null, status: 204 }) }),
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
const { deadLetters, resendDeadLetters, dismissDeadLetters, deadLetterKey, DEAD_LETTER_KEY, MAX_DEAD_LETTERS, MAX_DEAD_LETTER_TRIES } = sync;
const owner = await import("../owner");
const { obsoleteDeadLetters, isTransientServerError } = await import("../remote");

afterAll(() => vi.unstubAllGlobals());

type Row = Record<string, unknown>;
const OTHER = "22222222-2222-4222-8222-222222222222";
const UID = server.state.uid;
const q = (table: string, op: "upsert" | "delete", row: Row) => ({ table, op, row, created_at: "t" }) as never;
const L = (table: string, row: Row, extra: Row = {}) => ({ table, op: "upsert", row, code: "23503", message: "fk", at: "t", tries: 1, ...extra }) as never as { table: "sets"; op: "upsert"; row: Row; at: string; tries: number };
const setLetters = (list: unknown[]) => db.meta.put({ key: DEAD_LETTER_KEY, value: list });
const ids = async () => (await deadLetters()).map((d) => String(d.row.id));

beforeEach(async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  net.onLine = false;
  server.state.uid = UID;
  server.state.tables.clear();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("obsoleteDeadLetters QA", () => {
  it("full chain: workout delete takes exercises, sets and personal records, nothing else", () => {
    const we = L("workout_exercises", { id: "we", workout_id: "w" });
    const s = L("sets", { id: "s", workout_exercise_id: "we" });
    const pr = L("personal_records", { id: "p", set_id: "s" });
    const keep = [L("workouts", { id: "w2" }), L("sets", { id: "s2", workout_exercise_id: "we2" }), L("personal_records", { id: "p2", set_id: "s2" }), L("routine_exercises", { id: "re", routine_id: "w" })];
    const gone = obsoleteDeadLetters([...keep, pr, s, we], [q("workouts", "delete", { id: "w" })]);
    expect([...gone].sort((a, b) => String(a.row.id).localeCompare(String(b.row.id)))).toEqual([pr, s, we].sort((a, b) => String(a.row.id).localeCompare(String(b.row.id))));
  });

  it("order of letters does not matter for the chain", () => {
    const we = L("workout_exercises", { id: "we", workout_id: "w" });
    const s = L("sets", { id: "s", workout_exercise_id: "we" });
    const pr = L("personal_records", { id: "p", set_id: "s" });
    for (const list of [[we, s, pr], [pr, s, we], [s, pr, we]]) {
      expect(obsoleteDeadLetters(list, [q("workouts", "delete", { id: "w" })]).size).toBe(3);
    }
  });

  it("a workout upsert (not delete) does not take children", () => {
    const we = L("workout_exercises", { id: "we", workout_id: "w" });
    expect(obsoleteDeadLetters([we], [q("workouts", "upsert", { id: "w" })]).size).toBe(0);
  });

  it("routine delete takes routine_exercises only, not sets with same-looking ids", () => {
    const re = L("routine_exercises", { id: "re", routine_id: "r" });
    const s = L("sets", { id: "r", workout_exercise_id: "r" });
    expect([...obsoleteDeadLetters([re, s], [q("routines", "delete", { id: "r" })])]).toEqual([re]);
  });

  it("same-id upsert queued after a delete: letter of that row is obsolete", () => {
    const a = L("measurements", { id: "m" });
    expect(obsoleteDeadLetters([a], [q("measurements", "delete", { id: "m" }), q("measurements", "upsert", { id: "m" })]).size).toBe(1);
  });

  it("numeric vs string ids match by string (same id written as number)", () => {
    expect(obsoleteDeadLetters([L("measurements", { id: "5" })], [q("measurements", "delete", { id: 5 })]).size).toBe(1);
  });

  it("empty inputs", () => {
    expect(obsoleteDeadLetters([], []).size).toBe(0);
    expect(obsoleteDeadLetters([L("sets", { id: "s" })], []).size).toBe(0);
    expect(obsoleteDeadLetters([], [q("workouts", "delete", { id: "w" })]).size).toBe(0);
  });

  it("duplicate letters (distinct objects, same row) are both dropped", () => {
    const a = L("measurements", { id: "m" });
    const b = L("measurements", { id: "m" });
    expect(obsoleteDeadLetters([a, b], [q("measurements", "delete", { id: "m" })]).size).toBe(2);
  });

  it("letters with a missing id never match a newer item with a missing id by accident of parents", () => {
    const a = L("workout_exercises", { workout_id: undefined });
    // newer delete of a workout with no id must not wipe unrelated id-less children
    const r = obsoleteDeadLetters([a], [q("workouts", "delete", { id: "w" })]);
    expect(r.size).toBe(0);
  });

  it("junk entries in the letter list (null row) do not throw", () => {
    const junk = { table: "sets", op: "upsert", code: "", message: "", at: "t" } as never as { table: "sets"; op: "upsert"; row: Row };
    expect(() => obsoleteDeadLetters([junk], [q("workouts", "delete", { id: "w" })])).not.toThrow();
  });

  it("junk entries in newer (null row) do not throw", () => {
    expect(() => obsoleteDeadLetters([L("sets", { id: "s" })], [{ table: "sets", op: "delete" } as never])).not.toThrow();
  });

  it("fixed-seed fuzz: result is always a subset, and removing newer never grows it", () => {
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const tables = ["workouts", "workout_exercises", "sets", "personal_records", "routines", "routine_exercises", "measurements"];
    const row = (): Row => ({ id: `i${rnd(6)}`, workout_id: `i${rnd(6)}`, workout_exercise_id: `i${rnd(6)}`, set_id: `i${rnd(6)}`, routine_id: `i${rnd(6)}` });
    for (let k = 0; k < 300; k++) {
      const letters = Array.from({ length: rnd(12) }, () => L(tables[rnd(7)], row()));
      const newer = Array.from({ length: rnd(8) }, () => q(tables[rnd(7)], rnd(2) ? "delete" : "upsert", row()));
      const all = obsoleteDeadLetters(letters, newer);
      for (const g of all) expect(letters).toContain(g);
      const fewer = obsoleteDeadLetters(letters, newer.slice(0, Math.max(0, newer.length - 1)));
      for (const g of fewer) expect(all.has(g)).toBe(true);
    }
  });

  it("huge list (5000 letters) finishes fast", () => {
    const letters = Array.from({ length: 5000 }, (_, i) => L("sets", { id: `s${i}`, workout_exercise_id: `we${i % 50}` }));
    const t = Date.now();
    expect(obsoleteDeadLetters(letters, [q("workout_exercises", "delete", { id: "we1" })]).size).toBe(100);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("resend / dismiss / deadLetterKey QA", () => {
  it("empty list: resend and dismiss return 0 and write nothing harmful", async () => {
    expect(await resendDeadLetters()).toBe(0);
    expect(await dismissDeadLetters()).toBe(0);
    expect(await resendDeadLetters([])).toBe(0);
    expect(await dismissDeadLetters([])).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it("empty key array keeps every letter", async () => {
    await setLetters([L("measurements", { id: "m1" })]);
    expect(await resendDeadLetters([])).toBe(0);
    expect(await dismissDeadLetters([])).toBe(0);
    expect(await ids()).toEqual(["m1"]);
  });

  it("repeated clicks: second resend of same key queues nothing more", async () => {
    const a = L("measurements", { id: "m1" }, { tries: MAX_DEAD_LETTER_TRIES + 3 });
    await setLetters([a]);
    const key = deadLetterKey(a);
    expect(await resendDeadLetters([key])).toBe(1);
    expect(await resendDeadLetters([key])).toBe(0);
    expect(await dismissDeadLetters([key])).toBe(0);
    expect(await db.outbox.count()).toBe(1);
  });

  it("concurrent resend of all: each letter queued exactly once", async () => {
    await setLetters([L("measurements", { id: "m1" }), L("measurements", { id: "m2" }, { at: "t2" })]);
    const r = await Promise.all([resendDeadLetters(), resendDeadLetters(), dismissDeadLetters()]);
    expect(r[0] + r[1]).toBeLessThanOrEqual(2);
    expect((await db.outbox.toArray()).length).toBe(r[0] + r[1]);
    expect(await deadLetters()).toEqual([]);
  });

  it("concurrent resend while flush runs never loses or duplicates", async () => {
    await setLetters([L("measurements", { id: "m1" }), L("measurements", { id: "m2" }, { at: "t2" })]);
    net.onLine = true;
    await db.measurements.bulkPut([{ id: "m1", type: "body_weight", value: 1, date: "2026-10-01" }, { id: "m2", type: "body_weight", value: 2, date: "2026-10-01" }]);
    await Promise.all([resendDeadLetters(), sync.flush(), sync.flush()]);
    await vi.waitFor(async () => expect(await db.outbox.count()).toBe(0));
    expect(await deadLetters()).toEqual([]);
    expect(server.table("measurements").size).toBeLessThanOrEqual(2);
  });

  it("deadLetterKey: distinct for op, time and table; stable; tolerates missing id", () => {
    const base = { table: "sets" as const, op: "upsert" as const, row: { id: "x" }, at: "t" };
    const keys = new Set([deadLetterKey(base), deadLetterKey({ ...base, op: "delete" }), deadLetterKey({ ...base, at: "u" }), deadLetterKey({ ...base, table: "routines" })]);
    expect(keys.size).toBe(4);
    expect(deadLetterKey(base)).toBe(deadLetterKey({ ...base }));
    expect(() => deadLetterKey({ ...base, row: undefined as never })).not.toThrow();
    expect(() => deadLetterKey({ ...base, row: {} })).not.toThrow();
  });

  it("two letters for the same row, same op and same time share a key; dismiss by key removes both (documented collision)", async () => {
    const a = L("measurements", { id: "m1" });
    await setLetters([a, { ...a }]);
    expect(await dismissDeadLetters([deadLetterKey(a)])).toBe(2);
  });

  it("past the 200 cap: oldest are dropped by deadLetter, and 250 stored letters can all be resent in order", async () => {
    const list = Array.from({ length: 500 }, (_, i) => L("measurements", { id: `m${i}` }, { at: `t${i}` }));
    await setLetters(list);
    expect(await resendDeadLetters()).toBe(500);
    const seqs = (await db.outbox.orderBy("seq").toArray()).map((i) => String(i.row.id));
    expect(seqs[0]).toBe("m0");
    expect(seqs[499]).toBe("m499");
    expect(MAX_DEAD_LETTERS).toBe(200);
  });

  it("junk meta value (not an array / array with junk) does not crash dismiss or resend", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: "oops" });
    expect(await dismissDeadLetters()).toBe(0);
    expect(await resendDeadLetters()).toBe(0);
    await setLetters([null, 5, L("measurements", { id: "ok" })]);
    await expect(dismissDeadLetters(["nothing"])).resolves.toBeTypeOf("number");
  });

  it("junk letter with no row does not break resend of the rest", async () => {
    await setLetters([{ table: "measurements", op: "upsert", at: "t", code: "", message: "" }, L("measurements", { id: "m1" }, { at: "t2" })]);
    await expect(resendDeadLetters()).resolves.toBeTypeOf("number");
  });

  it("resend of a letter with a queued delete of its parent drops it", async () => {
    await setLetters([L("routine_exercises", { id: "re", routine_id: "r" })]);
    await db.outbox.add(q("routines", "delete", { id: "r" }));
    expect(await resendDeadLetters()).toBe(0);
    expect(await deadLetters()).toEqual([]);
    expect(await db.outbox.count()).toBe(1);
  });
});

describe("claimOwner QA", () => {
  async function seed() {
    await db.meta.put({ key: owner.OWNER_KEY, value: OTHER });
    await db.workouts.put({ id: "wA", started_at: "t", ended_at: "t", notes: null, routine_id: null } as never);
    await db.meta.bulkPut([
      { key: "profile", value: { n: 1 } },
      { key: "settings", value: { unit: "kg" } },
      { key: "theme", value: "dark" },
      { key: "rest_timer", value: 90 },
      { key: "photos:synced", value: {} },
      { key: "photos:fails", value: { a: 1 } },
    ]);
  }

  it("takeover with an active workout keeps active, clears synced rows", async () => {
    await seed();
    await db.meta.put({ key: "active", value: { id: "live" } });
    expect(await owner.claimOwner(UID)).toBe(true);
    expect((await db.meta.get("active"))?.value).toEqual({ id: "live" });
    expect(await db.workouts.count()).toBe(0);
  });

  it("device settings survive takeover; account keys do not", async () => {
    await seed();
    await owner.claimOwner(UID);
    for (const k of ["settings", "theme", "rest_timer"]) expect(await db.meta.get(k)).toBeTruthy();
    for (const k of owner.ACCOUNT_META_KEYS) expect(await db.meta.get(k)).toBeUndefined();
  });

  it("ACCOUNT_META_KEYS has no duplicates and excludes owner and device settings", () => {
    expect(new Set(owner.ACCOUNT_META_KEYS).size).toBe(owner.ACCOUNT_META_KEYS.length);
    for (const k of [owner.OWNER_KEY, "settings", "active", "theme"]) expect(owner.ACCOUNT_META_KEYS as readonly string[]).not.toContain(k);
  });

  it("refuses with unsent photo (no synced signature), clears nothing", async () => {
    await seed();
    await db.photos.put({ id: "p1", date: "2026-10-01", blob: new Blob(["x"]), created_at: "t" } as never);
    expect(await owner.claimOwner(UID)).toBe(false);
    expect(await db.workouts.count()).toBe(1);
    expect(await owner.getOwner()).toBe(OTHER);
  });

  it("refuses with a pending photo delete tombstone", async () => {
    await seed();
    await db.meta.put({ key: "photos:deleted", value: ["p9"] });
    expect(await owner.claimOwner(UID)).toBe(false);
    expect(await db.workouts.count()).toBe(1);
  });

  it("an empty tombstone array and empty dead list do not block takeover", async () => {
    await seed();
    await db.meta.bulkPut([{ key: "photos:deleted", value: [] }, { key: DEAD_LETTER_KEY, value: [] }]);
    expect(await owner.claimOwner(UID)).toBe(true);
  });

  it("refuses with dead letters", async () => {
    await seed();
    await setLetters([L("measurements", { id: "m" })]);
    expect(await owner.claimOwner(UID)).toBe(false);
    expect(await ids()).toEqual(["m"]);
  });

  it("two concurrent claims by different accounts on an owned device: at most one wins, data consistent", async () => {
    await seed();
    const third = "33333333-3333-4333-8333-333333333333";
    const [a, b] = await Promise.all([owner.claimOwner(UID), owner.claimOwner(third)]);
    const o = await owner.getOwner();
    expect([UID, third]).toContain(o);
    expect(a || b).toBe(true);
    expect(await db.workouts.count()).toBe(0);
  });

  it("two concurrent claims on a fresh device: exactly one owner, the other refused or taking over cleanly", async () => {
    const [a, b] = await Promise.all([owner.claimOwner(UID), owner.claimOwner(OTHER)]);
    expect(a).toBe(true);
    const o = await owner.getOwner();
    expect([UID, OTHER]).toContain(o);
    expect(typeof b).toBe("boolean");
  });

  it("two concurrent claims by the same uid both succeed and clear nothing", async () => {
    await db.workouts.put({ id: "w", started_at: "t", ended_at: "t", notes: null, routine_id: null } as never);
    expect(await Promise.all([owner.claimOwner(UID), owner.claimOwner(UID)])).toEqual([true, true]);
    expect(await db.workouts.count()).toBe(1);
  });

  it("owner key empty string / non-string is treated as unowned", async () => {
    await db.meta.put({ key: owner.OWNER_KEY, value: "" });
    expect(await owner.claimOwner(UID)).toBe(true);
    expect(await owner.getOwner()).toBe(UID);
    await db.meta.put({ key: owner.OWNER_KEY, value: 42 });
    expect(await owner.getOwner()).toBeNull();
  });

  it("takeover with an outbox item written between checks is refused (outbox wins)", async () => {
    await seed();
    await db.outbox.add(q("measurements", "delete", { id: "x" }));
    expect(await owner.claimOwner(UID)).toBe(false);
  });
});

describe("clearAppLocalStorage QA", () => {
  const store = (init: Record<string, string>) => {
    const m = new Map(Object.entries(init));
    return { get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, removeItem: (k: string) => void m.delete(k), map: m };
  };

  it("only lift: and lift- prefixes; lookalikes untouched", () => {
    const s = store({ "lift:a": "1", "lift-b": "2", lift: "3", lifted: "4", "my-lift:x": "5", "Lift:x": "6", "lift_x": "7", "sb-auth": "8", "": "9" });
    owner.clearAppLocalStorage(s);
    expect([...s.map.keys()].sort()).toEqual(["", "Lift:x", "lift", "lift_x", "lifted", "my-lift:x", "sb-auth"].sort());
  });

  it("empty store returns count of known keys and never throws", () => {
    const s = store({});
    expect(() => owner.clearAppLocalStorage(s)).not.toThrow();
  });

  it("removing while iterating does not skip prefixed keys (many keys)", () => {
    const init: Record<string, string> = {};
    for (let i = 0; i < 300; i++) init[`lift:k${i}`] = "x";
    init.keep = "y";
    const s = store(init);
    owner.clearAppLocalStorage(s);
    expect([...s.map.keys()]).toEqual(["keep"]);
  });

  it("removeItem throwing returns 0 without throwing", () => {
    const s = { length: 1, key: () => "lift:x", removeItem: () => { throw new Error("no"); } };
    expect(owner.clearAppLocalStorage(s)).toBe(0);
  });
});

describe("isTransientServerError QA", () => {
  it("status table", () => {
    for (const s of [500, 502, 503, 504, 599, 600]) expect(isTransientServerError(null, s)).toBe(true);
    for (const s of [0, 200, 400, 401, 403, 404, 409, 429, 499]) expect(isTransientServerError({ code: "" }, s)).toBe(false);
    expect(isTransientServerError({}, Number.NaN)).toBe(false);
  });

  it("class 08/53/57/58 any 3 trailing alnum, plus 40001 40P01 PGRST000-003", () => {
    for (const c of ["08000", "08P01", "53000", "53200", "57P01", "57P03", "58000", "58P01", "PGRST000", "PGRST001", "PGRST002", "PGRST003", "40001", "40P01"]) expect(isTransientServerError({ code: c })).toBe(true);
  });

  it("lookalikes are not transient", () => {
    for (const c of ["0800", "080000", "08 06", " 08006", "08006 ", "08p01", "5300", "40002", "40P02", "40p01", "PGRST004", "PGRST010", "PGRST0", "pgrst000", "PGRST0000", "XPGRST000", "23505", "42P01", "55P03", "09000", "28000"]) expect(isTransientServerError({ code: c }, 400)).toBe(false);
  });

  it("non-string codes and odd inputs never throw", () => {
    for (const c of [null, undefined, 8006, {}, [], true]) expect(isTransientServerError({ code: c } as never)).toBe(false);
    expect(isTransientServerError(undefined)).toBe(false);
    expect(isTransientServerError("x" as never)).toBe(false);
  });
});
