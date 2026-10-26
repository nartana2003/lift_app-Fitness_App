import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, type RoutineRow } from "../offline/db";
import { createRoutine, getRoutine, linkRoutineToDay, updateRoutine } from "../routines";
import {
  assignRoutine,
  clearLinksForRemovedDays,
  lastDoneByRoutine,
  nextRoutineForDay,
  routinesForDay,
  splitHasDayIds,
  unassignedRoutines,
  withDayIds,
  type LinkableRoutine,
} from "../splitRoutines";
import { clearSplit, ensureSplitDayIds, PRESETS, saveSplit, type Split } from "../splits";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

type L = LinkableRoutine & { name: string };
const r = (id: string, created_at: string, p: Partial<L> = {}): L => ({
  id,
  name: id,
  created_at,
  kind: "routine",
  ...p,
});

const counter = () => {
  let n = 0;
  return () => `id-${++n}`;
};

const PPL: Split = {
  name: "PPL",
  days: [
    { id: "push", name: "Push", muscles: ["Chest"] },
    { id: "pull", name: "Pull", muscles: ["Back"] },
    { id: "legs", name: "Legs", muscles: ["Quads"] },
  ],
};

describe("withDayIds", () => {
  it("gives every day an id without touching the input", () => {
    const legacy: Split = { name: "UL", days: [{ name: "Upper", muscles: ["Chest"] }, { name: "Lower", muscles: [] }] };
    const copy = structuredClone(legacy);
    const out = withDayIds(legacy, counter());
    expect(out.days.map((d) => d.id)).toEqual(["id-1", "id-2"]);
    expect(out.days.map((d) => d.name)).toEqual(["Upper", "Lower"]);
    expect(legacy).toEqual(copy);
    expect(splitHasDayIds(out)).toBe(true);
    expect(splitHasDayIds(legacy)).toBe(false);
  });

  it("keeps existing ids, and returns the same split when nothing is missing", () => {
    expect(withDayIds(PPL, counter())).toBe(PPL);
    const mixed: Split = { name: "x", days: [{ id: "keep", name: "A", muscles: [] }, { name: "B", muscles: [] }] };
    expect(withDayIds(mixed, counter()).days.map((d) => d.id)).toEqual(["keep", "id-1"]);
  });

  it("re-ids a repeated id (a copied day) and skips generated ids already in use", () => {
    const dup: Split = { name: "x", days: [{ id: "a", name: "A", muscles: [] }, { id: "a", name: "A copy", muscles: [] }] };
    expect(withDayIds(dup, counter()).days.map((d) => d.id)).toEqual(["a", "id-1"]);
    const clash: Split = { name: "x", days: [{ id: "id-1", name: "A", muscles: [] }, { name: "B", muscles: [] }] };
    expect(withDayIds(clash, counter()).days.map((d) => d.id)).toEqual(["id-1", "id-2"]);
    // A new day before an existing one never takes the existing day's id.
    const before: Split = { name: "x", days: [{ name: "New", muscles: [] }, { id: "id-1", name: "Old", muscles: [] }] };
    expect(withDayIds(before, counter()).days.map((d) => d.id)).toEqual(["id-2", "id-1"]);
  });

  it("ids stay the same when a day is renamed, reordered or its muscles edited", () => {
    const plain: Split = { name: "x", days: [{ name: "A", muscles: [] }, { name: "B", muscles: [] }] };
    const a = withDayIds(plain, counter());
    const edited: Split = {
      ...a,
      days: [{ ...a.days[1], name: "B renamed", muscles: ["Chest"] }, { ...a.days[0] }],
    };
    expect(withDayIds(edited, counter()).days.map((d) => d.id)).toEqual([a.days[1].id, a.days[0].id]);
  });
});

describe("routinesForDay / unassignedRoutines", () => {
  const routines = [
    r("push-b", "2026-02-01", { split_day_id: "push" }),
    r("push-a", "2026-01-01", { split_day_id: "push" }),
    r("push-mini", "2026-01-05", { kind: "mini", split_day_id: "push" }),
    r("loose", "2026-01-03"),
    r("unlinked", "2026-01-02", { split_day_id: null }),
    r("orphan", "2026-01-04", { split_day_id: "removed" }),
  ];

  it("lists full routines linked to a day, oldest first; minis only on request", () => {
    expect(routinesForDay(routines, "push").map((x) => x.id)).toEqual(["push-a", "push-b"]);
    expect(routinesForDay(routines, "push", { includeMini: true }).map((x) => x.id)).toEqual(["push-a", "push-mini", "push-b"]);
    expect(routinesForDay(routines, "pull")).toEqual([]);
    expect(routinesForDay(routines, null)).toEqual([]);
    expect(routinesForDay(routines, undefined)).toEqual([]);
  });

  it("treats no link and a link to a removed day as unassigned", () => {
    expect(unassignedRoutines(routines, PPL).map((x) => x.id)).toEqual(["unlinked", "loose", "orphan"]);
    // With no split everything is unassigned.
    expect(unassignedRoutines(routines, { days: [] })).toHaveLength(routines.length);
  });
});

describe("assignRoutine / clearLinksForRemovedDays", () => {
  it("links and unlinks one routine without touching the others", () => {
    const list = [r("a", "2026-01-01"), r("b", "2026-01-02", { split_day_id: "pull" })];
    const linked = assignRoutine(list, "a", "push");
    expect(linked.map((x) => x.split_day_id)).toEqual(["push", "pull"]);
    expect(linked[1]).toBe(list[1]);
    expect(list[0].split_day_id).toBeUndefined();
    expect(assignRoutine(linked, "a", null)[0].split_day_id).toBeNull();
  });

  it("names the routines whose day was removed, so they can be unlinked (never deleted)", () => {
    const list = [r("a", "2026-01-01", { split_day_id: "push" }), r("b", "2026-01-02", { split_day_id: "legs" }), r("c", "2026-01-03")];
    const withoutLegs: Split = { ...PPL, days: PPL.days.filter((d) => d.id !== "legs") };
    expect(clearLinksForRemovedDays(withoutLegs, list)).toEqual(["b"]);
    expect(clearLinksForRemovedDays(PPL, list)).toEqual([]);
    expect(clearLinksForRemovedDays({ days: [] }, list)).toEqual(["a", "b"]);
  });
});

describe("nextRoutineForDay", () => {
  const list = [
    r("a", "2026-01-01", { split_day_id: "push" }),
    r("b", "2026-01-02", { split_day_id: "push" }),
    r("c", "2026-01-03", { split_day_id: "push" }),
    r("mini", "2025-12-01", { kind: "mini", split_day_id: "push" }),
  ];

  it("picks the routine done longest ago, never-done first, ties oldest first", () => {
    expect(nextRoutineForDay(list, "push")!.id).toBe("a");
    const last = new Map([
      ["a", "2026-03-03T10:00:00Z"],
      ["b", "2026-03-01T10:00:00Z"],
    ]);
    expect(nextRoutineForDay(list, "push", last)!.id).toBe("c");
    last.set("c", "2026-03-02T10:00:00Z");
    expect(nextRoutineForDay(list, "push", last)!.id).toBe("b");
    const tie = new Map([
      ["a", "2026-03-01T10:00:00Z"],
      ["b", "2026-03-01T10:00:00Z"],
      ["c", "2026-03-01T10:00:00Z"],
    ]);
    expect(nextRoutineForDay(list, "push", tie)!.id).toBe("a");
  });

  it("never chooses a mini routine, and returns null for a day with nothing linked", () => {
    expect(nextRoutineForDay([list[3]], "push")).toBeNull();
    expect(nextRoutineForDay(list, "legs")).toBeNull();
    expect(nextRoutineForDay(list, undefined)).toBeNull();
  });

  it("lastDoneByRoutine keeps the latest workout per routine", () => {
    const m = lastDoneByRoutine([
      { routine_id: "a", started_at: "2026-03-01T10:00:00Z" },
      { routine_id: "a", started_at: "2026-03-05T10:00:00Z" },
      { routine_id: "a", started_at: "2026-03-02T10:00:00Z" },
      { routine_id: null, started_at: "2026-03-09T10:00:00Z" },
    ]);
    expect([...m]).toEqual([["a", "2026-03-05T10:00:00Z"]]);
  });
});

describe("stored splits and links", () => {
  const storedSplit = async () => (await db.meta.get("split"))?.value as Split;

  it("saveSplit assigns ids to new days and keeps existing ones; PRESETS are not changed", async () => {
    await saveSplit(PRESETS[0]);
    const first = await storedSplit();
    expect(splitHasDayIds(first)).toBe(true);
    expect(PRESETS[0].days.some((d) => "id" in d)).toBe(false);

    await saveSplit({ ...first, days: [...first.days.map((d) => ({ ...d, name: d.name + "!" })), { name: "Extra", muscles: [] }] });
    const second = await storedSplit();
    expect(second.days.slice(0, 3).map((d) => d.id)).toEqual(first.days.map((d) => d.id));
    expect(second.days[3].id).toBeTruthy();
  });

  it("a legacy split without ids gets ids once, written back, and they never change", async () => {
    await db.meta.put({ key: "split", value: { name: "UL", days: [{ name: "Upper", muscles: [] }, { name: "Lower", muscles: [] }] } });
    const [a, b] = await Promise.all([ensureSplitDayIds(), ensureSplitDayIds()]);
    const stored = await storedSplit();
    expect(splitHasDayIds(stored)).toBe(true);
    expect(a!.days.map((d) => d.id)).toEqual(stored.days.map((d) => d.id));
    expect(b!.days.map((d) => d.id)).toEqual(stored.days.map((d) => d.id));
    await ensureSplitDayIds();
    expect((await storedSplit()).days.map((d) => d.id)).toEqual(stored.days.map((d) => d.id));
    expect(await (async () => { await db.meta.delete("split"); return ensureSplitDayIds(); })()).toBeUndefined();
  });

  it("createRoutine and updateRoutine store the link and send it in the outbox row", async () => {
    const id = await createRoutine({ name: "Push A", exercises: [{ exercise_id: "bench" }], split_day_id: "push" });
    expect((await getRoutine(id))!.split_day_id).toBe("push");
    const created = (await db.outbox.orderBy("seq").toArray()).find((o) => o.table === "routines")!;
    expect(created.row).toMatchObject({ id, split_day_id: "push" });

    await db.outbox.clear();
    await linkRoutineToDay(id, "pull");
    expect((await db.routines.get(id))!.split_day_id).toBe("pull");
    expect((await db.routine_exercises.where("routine_id").equals(id).count())).toBe(1);
    const linked = await db.outbox.orderBy("seq").toArray();
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ table: "routines", op: "upsert", row: { id, split_day_id: "pull" } });

    await updateRoutine(id, { split_day_id: null });
    expect((await db.routines.get(id))!.split_day_id).toBeNull();
    // A rename leaves the link alone.
    await linkRoutineToDay(id, "legs");
    await updateRoutine(id, { name: "Renamed" });
    expect((await db.routines.get(id))!.split_day_id).toBe("legs");
  });

  it("existing callers that pass no link store no split_day_id field", async () => {
    const id = await createRoutine({ name: "Plain", exercises: [] });
    const row = (await db.routines.get(id)) as RoutineRow;
    expect("split_day_id" in row).toBe(false);
  });

  it("removing a day or replacing the split unlinks its routines and never deletes them", async () => {
    await saveSplit(PPL);
    const a = await createRoutine({ name: "Push A", exercises: [{ exercise_id: "bench" }], split_day_id: "push" });
    const b = await createRoutine({ name: "Legs A", exercises: [{ exercise_id: "squat" }], split_day_id: "legs" });
    const c = await createRoutine({ name: "Legs B", exercises: [], split_day_id: "legs" });

    await saveSplit({ ...PPL, days: PPL.days.filter((d) => d.id !== "legs") });
    expect((await db.routines.get(a))!.split_day_id).toBe("push");
    expect((await db.routines.get(b))!.split_day_id).toBeNull();
    expect((await db.routines.get(c))!.split_day_id).toBeNull();
    expect(await db.routines.count()).toBe(3);
    expect(await db.routine_exercises.where("routine_id").equals(b).count()).toBe(1);

    await saveSplit(PRESETS[1]);
    expect((await db.routines.get(a))!.split_day_id).toBeNull();

    await linkRoutineToDay(a, (await storedSplit()).days[0].id!);
    await clearSplit();
    expect((await db.routines.get(a))!.split_day_id).toBeNull();
    expect(await db.routines.count()).toBe(3);
  });
});
