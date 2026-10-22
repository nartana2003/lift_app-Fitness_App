import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, type PlannedDayRow } from "../offline/db";
import { getDay, markDone, moveDay, planDay, rescheduleDay, skipDay, swapDays, undoSkip } from "../planner";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const MON = "2026-10-12";
const WED = "2026-10-14";
const THU = "2026-10-15";
const FRI = "2026-10-16";

/** Days holding a routine as planned or done (not the "moved" origin row). */
const holding = async (routineId: string) =>
  (await db.planned_days.toArray())
    .filter((r) => r.routine_id === routineId && (r.status === "planned" || r.status === "done"))
    .map((r) => r.date)
    .sort();

describe("rescheduleDay", () => {
  it("moves the routine to a free day and clears the old day, with no skip reason", async () => {
    await planDay(MON, "r1");
    await db.outbox.clear();
    expect(await rescheduleDay(MON, THU)).toBe(true);

    expect(await getDay(MON)).toBeUndefined();
    expect(await getDay(THU)).toMatchObject({ routine_id: "r1", status: "planned", skip_reason: null, moved_from: null });
    const outbox = await db.outbox.orderBy("seq").toArray();
    expect(outbox.map((o) => o.op)).toEqual(["upsert", "delete"]);
    expect(outbox[0].row).toMatchObject({ date: THU, routine_id: "r1" });
  });

  it("refuses a day that already holds a routine or was trained", async () => {
    await planDay(MON, "r1");
    await planDay(THU, "r2");
    expect(await rescheduleDay(MON, THU)).toBe(false);
    await clearDayThenDone(FRI);
    expect(await rescheduleDay(MON, FRI)).toBe(false);
    expect(await getDay(MON)).toMatchObject({ routine_id: "r1", status: "planned" });
  });

  it("refuses to drag a skipped day", async () => {
    await planDay(MON, "r1");
    await skipDay(MON, "tired");
    expect(await rescheduleDay(MON, THU)).toBe(false);
    expect(await getDay(THU)).toBeUndefined();
  });
});

async function clearDayThenDone(date: string) {
  await planDay(date, "rx");
  await markDone(date, "w1");
}

describe("swapDays", () => {
  it("swaps the routines of two planned days", async () => {
    await planDay(MON, "r1");
    await planDay(THU, "r2");
    expect(await swapDays(MON, THU)).toBe(true);
    expect(await getDay(MON)).toMatchObject({ routine_id: "r2", status: "planned" });
    expect(await getDay(THU)).toMatchObject({ routine_id: "r1", status: "planned" });
  });

  it("refuses when either day is not planned", async () => {
    await planDay(MON, "r1");
    expect(await swapDays(MON, THU)).toBe(false);
    await planDay(THU, "r2");
    await markDone(THU, "w1");
    expect(await swapDays(MON, THU)).toBe(false);
    expect(await getDay(MON)).toMatchObject({ routine_id: "r1" });
  });
});

describe("rescheduling is atomic", () => {
  let failOn: string | null = null;
  const fail = (date: string | undefined) => {
    if (date && date === failOn) throw new Error("disk full");
  };
  const onDeleting = (_k: unknown, obj: PlannedDayRow) => fail(obj.date);
  const onUpdating = (_m: unknown, _k: unknown, obj: PlannedDayRow) => fail(obj.date);

  afterEach(() => {
    failOn = null;
    db.planned_days.hook("deleting").unsubscribe(onDeleting);
    db.planned_days.hook("updating").unsubscribe(onUpdating);
  });

  it("rescheduleDay leaves both days unchanged when the second write fails", async () => {
    await planDay(MON, "r1");
    const before = await getDay(MON);
    const outboxBefore = await db.outbox.count();
    // The new day is written first; clearing the old day then fails.
    failOn = MON;
    db.planned_days.hook("deleting", onDeleting);

    await expect(rescheduleDay(MON, THU)).rejects.toThrow();

    expect(await getDay(MON)).toEqual(before);
    expect(await getDay(THU)).toBeUndefined();
    expect(await db.outbox.count()).toBe(outboxBefore);
  });

  it("swapDays leaves both days unchanged when the second write fails", async () => {
    await planDay(MON, "r1");
    await planDay(THU, "r2");
    const monBefore = await getDay(MON);
    const thuBefore = await getDay(THU);
    const outboxBefore = await db.outbox.count();
    // MON is written first; the write to THU then fails.
    failOn = THU;
    db.planned_days.hook("updating", onUpdating);

    await expect(swapDays(MON, THU)).rejects.toThrow();

    expect(await getDay(MON)).toEqual(monBefore);
    expect(await getDay(THU)).toEqual(thuBefore);
    expect(await db.outbox.count()).toBe(outboxBefore);
  });
});

describe("skip-and-move links survive a drag", () => {
  it("dragging a moved-to day carries the link, and undo removes the routine from the new day", async () => {
    await planDay(MON, "r1");
    await moveDay(MON, WED, "busy");
    expect(await rescheduleDay(WED, FRI)).toBe(true);

    expect(await getDay(MON)).toMatchObject({ status: "moved", moved_to: FRI });
    expect(await getDay(FRI)).toMatchObject({ routine_id: "r1", status: "planned", moved_from: MON });
    expect(await getDay(WED)).toBeUndefined();

    await undoSkip(MON);
    expect(await holding("r1")).toEqual([MON]);
    expect(await getDay(MON)).toMatchObject({ status: "planned", moved_to: null });
    expect(await getDay(FRI)).toBeUndefined();
  });

  it("swapping a moved-to day moves the link with the routine", async () => {
    await planDay(MON, "r1");
    await moveDay(MON, WED, "busy");
    await planDay(FRI, "r2");
    expect(await swapDays(WED, FRI)).toBe(true);

    expect(await getDay(MON)).toMatchObject({ moved_to: FRI });
    expect(await getDay(FRI)).toMatchObject({ routine_id: "r1", moved_from: MON });
    expect(await getDay(WED)).toMatchObject({ routine_id: "r2", moved_from: null });

    await undoSkip(MON);
    expect(await holding("r1")).toEqual([MON]);
    expect(await holding("r2")).toEqual([WED]);
  });

  it("swapping two moved-to days relinks both origins", async () => {
    await planDay(MON, "r1");
    await planDay(THU, "r2");
    await moveDay(MON, WED, "busy");
    await moveDay(THU, FRI, "tired");
    expect(await swapDays(WED, FRI)).toBe(true);

    expect(await getDay(MON)).toMatchObject({ moved_to: FRI });
    expect(await getDay(THU)).toMatchObject({ moved_to: WED });
    expect(await getDay(FRI)).toMatchObject({ routine_id: "r1", moved_from: MON });
    expect(await getDay(WED)).toMatchObject({ routine_id: "r2", moved_from: THU });

    await undoSkip(MON);
    await undoSkip(THU);
    expect(await holding("r1")).toEqual([MON]);
    expect(await holding("r2")).toEqual([THU]);
  });
});
