import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, type RoutineRow } from "../offline/db";
import { createRoutine, linkRoutineToDay, updateRoutine, deleteRoutine } from "../routines";
import {
  assignRoutine,
  clearLinksForRemovedDays,
  lastDoneByRoutine,
  nextRoutineForDay,
  routinesForDay,
  splitHasDayIds,
  unassignedRoutines,
  withDayIds,
} from "../splitRoutines";
import { clearSplit, ensureSplitDayIds, PRESETS, saveSplit, type Split } from "../splits";
import { splitRoutineOrder } from "../autofill";
import { exportBackup, importBackup, parseBackup, serializeBackup } from "../dataExport";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const R = (id: string, o: Partial<RoutineRow> = {}) => ({
  id,
  name: id,
  day_label: null,
  created_at: `2026-10-0${id.length}T00:00:00.000Z`,
  ...o,
});
const stored = async () => (await db.meta.get("split"))?.value as Split;

// mulberry32 for fixed-seed fuzz
const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("withDayIds edge cases", () => {
  it("handles an empty split and does not mutate input", () => {
    const s = { name: "x", days: [] };
    expect(withDayIds(s)).toBe(s);
    const legacy = { name: "x", days: [{ name: "A", muscles: [] }] };
    const out = withDayIds(legacy, () => "n1");
    expect(legacy.days[0]).not.toHaveProperty("id");
    expect((out.days[0] as { id?: string }).id).toBe("n1");
  });

  it("treats non-string, empty and repeated ids as missing, keeps the first repeat", () => {
    const s = {
      name: "x",
      days: [
        { name: "A", muscles: [], id: "a" },
        { name: "B", muscles: [], id: "a" },
        { name: "C", muscles: [], id: "" },
        { name: "D", muscles: [], id: 5 as unknown as string },
      ],
    };
    let n = 0;
    const out = withDayIds(s, () => (n++ < 1 ? "a" : `g${n}`));
    expect(out.days[0].id).toBe("a");
    const ids = out.days.map((d) => d.id!);
    expect(new Set(ids).size).toBe(4);
    expect(splitHasDayIds(out)).toBe(true);
  });

  it("fuzz: ids unique, existing unique ids never change, idempotent", () => {
    const r = rng(42);
    for (let k = 0; k < 200; k++) {
      const n = Math.floor(r() * 9);
      const days = Array.from({ length: n }, (_, i) => {
        const x = r();
        return { name: `d${i}`, muscles: [], ...(x < 0.4 ? { id: `p${Math.floor(r() * 4)}` } : x < 0.5 ? { id: "" } : {}) };
      });
      let c = 0;
      const out = withDayIds({ name: "f", days }, () => `new${c++}`);
      const ids = out.days.map((d) => d.id!);
      expect(new Set(ids).size).toBe(n);
      expect(ids.every(Boolean)).toBe(true);
      const first = new Map<string, number>();
      days.forEach((d, i) => {
        const id = (d as { id?: string }).id;
        if (id && !first.has(id)) first.set(id, i);
      });
      first.forEach((i, id) => expect(out.days[i].id).toBe(id));
      expect(withDayIds(out)).toBe(out);
    }
  });
});

describe("helpers: boundaries", () => {
  it("empty / null day ids and empty lists", () => {
    expect(routinesForDay([], "d")).toEqual([]);
    expect(routinesForDay([R("a", { split_day_id: "d" })], null)).toEqual([]);
    expect(routinesForDay([R("a", { split_day_id: "" })], "")).toEqual([]);
    expect(nextRoutineForDay([], "d")).toBeNull();
    expect(unassignedRoutines([], { days: [] })).toEqual([]);
    expect(clearLinksForRemovedDays({ days: [] }, [])).toEqual([]);
  });

  it("does not mutate the routines array it is given", () => {
    const rs = [R("bbb", { split_day_id: "d", created_at: "2026-10-02" }), R("a", { split_day_id: "d", created_at: "2026-10-01" })];
    const copy = [...rs];
    routinesForDay(rs, "d");
    unassignedRoutines(rs, { days: [] });
    expect(rs).toEqual(copy);
    expect(rs[0].id).toBe("bbb");
  });

  it("with a split without ids, linked routines are unassigned and flagged for unlinking", () => {
    const rs = [R("a", { split_day_id: "x" }), R("b")];
    expect(unassignedRoutines(rs, { days: [{ name: "A", muscles: [] }] }).length).toBe(2);
    expect(clearLinksForRemovedDays({ days: [{ name: "A", muscles: [] }] }, rs)).toEqual(["a"]);
  });

  it("mini routines are linkable but not chosen; only-mini day gives null", () => {
    const rs = [R("m", { kind: "mini", split_day_id: "d" })];
    expect(nextRoutineForDay(rs, "d")).toBeNull();
    expect(routinesForDay(rs, "d")).toEqual([]);
    expect(routinesForDay(rs, "d", { includeMini: true }).length).toBe(1);
    expect(unassignedRoutines(rs, { days: [{ name: "x", muscles: [], id: "other" }] }).length).toBe(1);
  });

  it("nextRoutineForDay: never-done wins over done; ties oldest; most-stale among done", () => {
    const rs = [
      R("a", { split_day_id: "d", created_at: "2026-01-01" }),
      R("b", { split_day_id: "d", created_at: "2026-01-02" }),
      R("c", { split_day_id: "d", created_at: "2026-01-03" }),
    ];
    const done = new Map([
      ["a", "2026-10-05"],
      ["b", "2026-10-01"],
      ["c", "2026-10-01"],
    ]);
    expect(nextRoutineForDay(rs, "d", done)?.id).toBe("b");
    done.set("c", "2026-09-01");
    expect(nextRoutineForDay(rs, "d", done)?.id).toBe("c");
    done.delete("a");
    expect(nextRoutineForDay(rs, "d", done)?.id).toBe("a");
    expect(nextRoutineForDay(rs, "d")?.id).toBe("a");
  });

  it("lastDoneByRoutine ignores null routines and keeps the latest", () => {
    const m = lastDoneByRoutine([
      { routine_id: null, started_at: "2030" },
      { routine_id: "a", started_at: "2026-02" },
      { routine_id: "a", started_at: "2026-03" },
      { routine_id: "a", started_at: "2026-01" },
    ]);
    expect([...m]).toEqual([["a", "2026-03"]]);
  });

  it("huge input stays fast and correct", () => {
    const rs = Array.from({ length: 20000 }, (_, i) =>
      R(`r${i}`, { split_day_id: i % 2 ? "d" : null, created_at: new Date(2026, 0, 1, 0, 0, i).toISOString() }),
    );
    const t = Date.now();
    expect(routinesForDay(rs, "d").length).toBe(10000);
    expect(nextRoutineForDay(rs, "d")?.id).toBe("r1");
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("assignRoutine unknown id changes nothing", () => {
    const rs = [R("a")];
    expect(assignRoutine(rs, "zzz", "d")).toEqual(rs);
    expect(assignRoutine(rs, "a", null)[0].split_day_id).toBeNull();
  });
});

describe("splitRoutineOrder with links", () => {
  const split = (): Split => ({
    name: "s",
    days: [
      { name: "Push", muscles: [], id: "p" },
      { name: "Pull", muscles: [], id: "q" },
    ],
  });
  it("legacy split (no ids) ignores links and falls back to names", () => {
    const legacy = { name: "L", days: [{ name: "Push", muscles: [] }, { name: "Pull", muscles: [] }] } as Split;
    const rs = [R("x1", { name: "Pull", split_day_id: "q" }), R("x22", { name: "Push" })];
    expect(splitRoutineOrder(legacy, rs)).toEqual(["x22", "x1"]);
  });
  it("a routine linked to another day is not name-matched onto a different day", () => {
    const rs = [R("a1", { name: "Push", split_day_id: "q" })];
    expect(splitRoutineOrder(split(), rs)).toEqual(["a1"]);
    const two = [R("a1", { name: "Push", split_day_id: "q" }), R("b22", { name: "Other" })];
    // day p (Push) must not grab a1, which belongs to q; a1 is used once for q
    expect(splitRoutineOrder(split(), two)).toEqual(["a1"]);
  });
  it("link to a removed day: routine is freed for name matching", () => {
    const rs = [R("a1", { name: "Push", split_day_id: "gone" })];
    expect(splitRoutineOrder(split(), rs)).toEqual(["a1"]);
  });
  it("lastDone rotates between two routines on one day", () => {
    const rs = [R("a1", { split_day_id: "p" }), R("b22", { split_day_id: "p", created_at: "2026-11-01" })];
    expect(splitRoutineOrder(split(), rs, new Map())).toEqual(["a1"]);
    expect(splitRoutineOrder(split(), rs, new Map([["a1", "2026-10-20"]]))).toEqual(["b22"]);
  });
  it("mini routines linked to a day are never used", () => {
    const rs = [R("m", { kind: "mini", split_day_id: "p" }), R("f22", { name: "other" })];
    expect(splitRoutineOrder(split(), rs)).toEqual(["f22"]);
  });
});

describe("stored splits and links (Dexie)", () => {
  it("legacy stored split with no ids: ids written once, stable on repeat and in parallel", async () => {
    await db.meta.put({ key: "split", value: { name: "L", days: [{ name: "A", muscles: ["Chest"] }, { name: "B", muscles: [] }] } });
    const [x, y, z] = await Promise.all([ensureSplitDayIds(), ensureSplitDayIds(), ensureSplitDayIds()]);
    expect(x!.days.map((d) => d.id)).toEqual(y!.days.map((d) => d.id));
    expect(z!.days.map((d) => d.id)).toEqual((await stored()).days.map((d) => d.id));
    const before = (await stored()).days.map((d) => d.id);
    await ensureSplitDayIds();
    expect((await stored()).days.map((d) => d.id)).toEqual(before);
  });

  it("ensureSplitDayIds with no split, or a malformed stored value, does not throw", async () => {
    expect(await ensureSplitDayIds()).toBeUndefined();
    await db.meta.put({ key: "split", value: { name: "bad" } });
    await expect(ensureSplitDayIds()).resolves.toBeDefined();
  });

  it("rename, reorder, muscle edit and add keep ids and links", async () => {
    await saveSplit(PRESETS[0]);
    const s0 = await stored();
    const [push, pull, legs] = s0.days;
    const rid = await createRoutine({ name: "R", exercises: [], split_day_id: pull.id });
    await saveSplit({
      ...s0,
      days: [legs, { ...pull, name: "Renamed", muscles: ["Back"] }, push, { name: "New", muscles: [] }],
    });
    const s1 = await stored();
    expect(s1.days.map((d) => d.id).slice(0, 3)).toEqual([legs.id, pull.id, push.id]);
    expect(s1.days[3].id).toBeTruthy();
    expect((await db.routines.get(rid))!.split_day_id).toBe(pull.id);
  });

  it("removing a day unlinks its routines but never deletes them or their exercises", async () => {
    await saveSplit(PRESETS[0]);
    const s0 = await stored();
    const rid = await createRoutine({ name: "R", exercises: [{ exercise_id: "barbell-bench-press" }], split_day_id: s0.days[2].id });
    await saveSplit({ ...s0, days: s0.days.slice(0, 2) });
    const r = await db.routines.get(rid);
    expect(r).toBeDefined();
    expect(r!.split_day_id ?? null).toBeNull();
    expect(await db.routine_exercises.where("routine_id").equals(rid).count()).toBe(1);
  });

  it("re-adding a deleted day with the same name does not resurrect the link", async () => {
    await saveSplit(PRESETS[0]);
    const s0 = await stored();
    const rid = await createRoutine({ name: "R", exercises: [], split_day_id: s0.days[0].id });
    await saveSplit({ ...s0, days: s0.days.slice(1) });
    await saveSplit({ ...s0, days: [{ name: "Push", muscles: [] }, ...s0.days.slice(1)] });
    expect((await db.routines.get(rid))!.split_day_id ?? null).toBeNull();
  });

  it("replacing with a preset and clearSplit unlink everything, routines survive", async () => {
    await saveSplit(PRESETS[0]);
    const s0 = await stored();
    const a = await createRoutine({ name: "A", exercises: [], split_day_id: s0.days[0].id });
    const m = await createRoutine({ name: "M", exercises: [], kind: "mini", split_day_id: s0.days[1].id });
    await saveSplit(PRESETS[1]);
    expect((await db.routines.get(a))!.split_day_id ?? null).toBeNull();
    expect((await db.routines.get(m))!.split_day_id ?? null).toBeNull();
    const s1 = await stored();
    const b = await createRoutine({ name: "B", exercises: [], split_day_id: s1.days[0].id });
    await clearSplit();
    expect((await db.routines.get(b))!.split_day_id ?? null).toBeNull();
    expect(await db.routines.count()).toBe(3);
  });

  it("saving a preset never writes ids into PRESETS; two saves get different ids", async () => {
    await saveSplit(PRESETS[0]);
    const a = (await stored()).days.map((d) => d.id);
    await saveSplit(PRESETS[0]);
    const b = (await stored()).days.map((d) => d.id);
    expect(PRESETS[0].days.every((d) => !("id" in d))).toBe(true);
    expect(a.some((id, i) => id === b[i])).toBe(false);
  });

  it("concurrent saveSplit of an id-less split leaves one stored split with ids", async () => {
    const s: Split = { name: "c", days: [{ name: "A", muscles: [] }, { name: "B", muscles: [] }] };
    await Promise.all([saveSplit(s), saveSplit(s), ensureSplitDayIds()]);
    expect(splitHasDayIds(await stored())).toBe(true);
  });

  it("concurrent saves of the same id-ed split do not wipe valid links", async () => {
    await saveSplit(PRESETS[0]);
    const s0 = await stored();
    const rid = await createRoutine({ name: "R", exercises: [], split_day_id: s0.days[1].id });
    await Promise.all(Array.from({ length: 6 }, () => saveSplit({ ...s0 })));
    expect((await db.routines.get(rid))!.split_day_id).toBe(s0.days[1].id);
  });

  it("a link made while a save interleaves is not lost", async () => {
    await saveSplit(PRESETS[0]);
    const s0 = await stored();
    const rid = await createRoutine({ name: "R", exercises: [] });
    await Promise.all([linkRoutineToDay(rid, s0.days[0].id!), saveSplit({ ...s0, name: "renamed split" })]);
    expect((await db.routines.get(rid))!.split_day_id).toBe(s0.days[0].id);
  });
});

describe("routine write API", () => {
  it("no split_day_id given: field absent; empty string becomes null; unknown routine is a no-op", async () => {
    const id = await createRoutine({ name: "x", exercises: [] });
    expect(await db.routines.get(id)).not.toHaveProperty("split_day_id");
    const id2 = await createRoutine({ name: "y", exercises: [], split_day_id: "" });
    expect((await db.routines.get(id2))!.split_day_id).toBeNull();
    await linkRoutineToDay("missing", "d");
    expect(await db.routines.get("missing")).toBeUndefined();
  });

  it("updateRoutine without split_day_id keeps the link; link/unlink/relink round trips", async () => {
    const id = await createRoutine({ name: "x", exercises: [], split_day_id: "d1" });
    await updateRoutine(id, { name: "renamed", exercises: [{ exercise_id: "barbell-bench-press" }] });
    expect((await db.routines.get(id))!.split_day_id).toBe("d1");
    await linkRoutineToDay(id, null);
    expect((await db.routines.get(id))!.split_day_id).toBeNull();
    await linkRoutineToDay(id, "d2");
    expect((await db.routines.get(id))!.split_day_id).toBe("d2");
  });

  it("outbox rows carry the link, including an explicit null on unlink", async () => {
    const id = await createRoutine({ name: "x", exercises: [], split_day_id: "d1" });
    await db.outbox.clear();
    await linkRoutineToDay(id, null);
    const rows = (await db.outbox.toArray()).filter((o) => o.table === "routines");
    expect(rows).toHaveLength(1);
    expect((rows[0].row as Record<string, unknown>).split_day_id).toBeNull();
  });

  it("deleting a routine leaves the split untouched", async () => {
    await saveSplit(PRESETS[0]);
    const s0 = await stored();
    const id = await createRoutine({ name: "x", exercises: [], split_day_id: s0.days[0].id });
    await deleteRoutine(id);
    expect(await stored()).toEqual(s0);
  });
});

describe("data export / import", () => {
  it("round trip through JSON text keeps split_day_id (string, null, absent) and the split ids", async () => {
    await saveSplit(PRESETS[0]);
    const s0 = await stored();
    const a = await createRoutine({ name: "a", exercises: [{ exercise_id: "barbell-bench-press" }], split_day_id: s0.days[0].id });
    const b = await createRoutine({ name: "b", exercises: [], split_day_id: null });
    const c = await createRoutine({ name: "c", exercises: [] });
    const text = serializeBackup(await exportBackup());
    await Promise.all(db.tables.map((t) => t.clear()));
    const parsed = parseBackup(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await importBackup(parsed.backup);
    expect((await db.routines.get(a))!.split_day_id).toBe(s0.days[0].id);
    expect((await db.routines.get(b))!.split_day_id ?? null).toBeNull();
    expect((await db.routines.get(c))!.split_day_id ?? null).toBeNull();
    expect(await stored()).toEqual(s0);
    const again = await importBackup(parsed.backup);
    expect(again.added.routines).toBe(0);
  });

  it("imported routines reach the outbox with split_day_id", async () => {
    const id = await createRoutine({ name: "a", exercises: [], split_day_id: "dayX" });
    const backup = await exportBackup();
    await Promise.all(db.tables.map((t) => t.clear()));
    await importBackup(backup);
    const row = (await db.outbox.toArray()).find((o) => o.table === "routines" && (o.row as { id: string }).id === id);
    expect((row!.row as Record<string, unknown>).split_day_id).toBe("dayX");
  });

  it("a backup from before ids (no split_day_id, legacy split) imports and loads", async () => {
    const legacyId = await createRoutine({ name: "old", exercises: [] });
    await db.meta.put({ key: "split", value: { name: "L", days: [{ name: "A", muscles: [] }] } });
    const text = serializeBackup(await exportBackup());
    await Promise.all(db.tables.map((t) => t.clear()));
    const p = parseBackup(text);
    expect(p.ok).toBe(true);
    if (p.ok) await importBackup(p.backup);
    expect(await db.routines.get(legacyId)).toBeDefined();
    const s = await ensureSplitDayIds();
    expect(splitHasDayIds(s!)).toBe(true);
  });

  it("parseBackup rejects a non-text split_day_id", async () => {
    await createRoutine({ name: "a", exercises: [], split_day_id: "d" });
    const b = JSON.parse(serializeBackup(await exportBackup()));
    b.tables.routines[0].split_day_id = 7;
    expect(parseBackup(JSON.stringify(b)).ok).toBe(false);
    b.tables.routines[0].split_day_id = ["d"];
    expect(parseBackup(JSON.stringify(b)).ok).toBe(false);
  });

  it("importing into a device with a different split leaves the link dangling but harmless", async () => {
    await saveSplit(PRESETS[0]);
    const s0 = await stored();
    const id = await createRoutine({ name: "a", exercises: [], split_day_id: s0.days[0].id });
    const backup = await exportBackup();
    await Promise.all(db.tables.map((t) => t.clear()));
    await saveSplit(PRESETS[1]);
    await importBackup(backup);
    const other = await stored();
    expect(other.name).toBe(PRESETS[1].name);
    const r = (await db.routines.toArray()).filter((x) => x.id === id);
    expect(unassignedRoutines(r, other).length).toBe(1);
    expect(clearLinksForRemovedDays(other, r)).toEqual([id]);
  });
});
