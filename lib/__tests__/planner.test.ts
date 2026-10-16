import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, type PlannedDayRow } from "../offline/db";
import { clearDay, dayKey, getDay, markDone, moveDay, moveOptions, planDay, skipDay, undoSkip, weekDays } from "../planner";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const MON = "2026-10-12";
const THU = "2026-10-15";

describe("weekDays", () => {
  it("returns 7 days starting on the chosen first day", () => {
    const wed = new Date(2026, 9, 14);
    expect(weekDays(1, wed).map(dayKey)[0]).toBe("2026-10-12"); // Monday
    expect(weekDays(0, wed).map(dayKey)[0]).toBe("2026-10-11"); // Sunday
    expect(weekDays(1, wed)).toHaveLength(7);
  });
});

describe("planning a day", () => {
  it("plans, then clears", async () => {
    await planDay(MON, "r1");
    expect(await getDay(MON)).toMatchObject({ routine_id: "r1", status: "planned" });
    const outbox = await db.outbox.toArray();
    expect(outbox[0]).toMatchObject({ table: "planned_days", op: "upsert" });

    await clearDay(MON);
    expect(await getDay(MON)).toBeUndefined();
    expect((await db.outbox.toArray()).at(-1)).toMatchObject({ op: "delete" });
  });

  it("keeps one row per day when re-planned", async () => {
    await planDay(MON, "r1");
    await planDay(MON, "r2");
    expect(await db.planned_days.count()).toBe(1);
    expect((await getDay(MON))!.routine_id).toBe("r2");
  });
});

describe("skipping and moving", () => {
  it("records the reason and note", async () => {
    await planDay(MON, "r1");
    await skipDay(MON, "sick", "  flu  ");
    expect(await getDay(MON)).toMatchObject({ status: "skipped", skip_reason: "sick", skip_note: "flu" });
  });

  it("moves the routine to another day and marks the original", async () => {
    await planDay(MON, "r1");
    await moveDay(MON, THU, "busy");

    expect(await getDay(MON)).toMatchObject({ status: "moved", skip_reason: "busy", moved_to: THU, routine_id: "r1" });
    expect(await getDay(THU)).toMatchObject({ status: "planned", routine_id: "r1", moved_from: MON });
  });

  it("undoing a move removes the new day again", async () => {
    await planDay(MON, "r1");
    await moveDay(MON, THU, "busy");
    await undoSkip(MON);

    expect(await getDay(MON)).toMatchObject({ status: "planned", skip_reason: null, moved_to: null });
    expect(await getDay(THU)).toBeUndefined();
  });

  it("undoing a move keeps the new day if it's already done", async () => {
    await planDay(MON, "r1");
    await moveDay(MON, THU, "busy");
    await markDone(THU, "w1");
    await undoSkip(MON);

    expect(await getDay(THU)).toMatchObject({ status: "done", workout_id: "w1" });
  });

  it("undoing a plain skip just re-plans the day", async () => {
    await planDay(MON, "r1");
    await skipDay(MON, "tired");
    await undoSkip(MON);
    expect(await getDay(MON)).toMatchObject({ status: "planned", skip_reason: null, routine_id: "r1" });
  });
});

describe("moveOptions", () => {
  const days = weekDays(1, new Date(2026, 9, 14)); // Mon 12 – Sun 18 Oct
  const now = new Date(2026, 9, 14, 12); // Wed

  const plan = (rows: Partial<PlannedDayRow>[]) =>
    new Map(rows.map((r) => [r.date!, { ...r, id: "x", status: r.status ?? "planned" } as PlannedDayRow]));

  it("offers only free days from today onwards", () => {
    const opts = moveOptions(days, plan([{ date: MON, routine_id: "r1" }, { date: "2026-10-16", routine_id: "r2" }]), MON, now);
    expect(opts.map(dayKey)).toEqual(["2026-10-14", "2026-10-15", "2026-10-17", "2026-10-18"]);
  });

  it("excludes days already trained", () => {
    const opts = moveOptions(days, plan([{ date: "2026-10-15", status: "done" }]), MON, now);
    expect(opts.map(dayKey)).not.toContain("2026-10-15");
  });
});
