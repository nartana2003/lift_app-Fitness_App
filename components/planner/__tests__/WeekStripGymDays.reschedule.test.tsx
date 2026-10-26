// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/offline/db";
import { createRoutine } from "@/lib/routines";
import { getDay, markGymDay, moveDay, planDay, rescheduleDay, undoSkip } from "@/lib/planner";

// QA-WEEK-01 rework: a mark on a date survives undoing a move that lands there,
// whether it got there by skip-and-move or by dragging (rescheduleDay).
const THU = "2026-10-15";
const FRI = "2026-10-16";
const SAT = "2026-10-17";
const SUN = "2026-10-18";

let pushId = "";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  pushId = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench" }] });
});

describe("was_marked through moves and drags", () => {
  it("undo of a skip-and-move onto a marked date restores a clean mark", async () => {
    await markGymDay(THU);
    await planDay(FRI, pushId);
    await moveDay(FRI, THU, "busy");
    expect((await getDay(THU))!.was_marked).toBe(true);
    await undoSkip(FRI);
    const thu = (await getDay(THU))!;
    expect(thu).toMatchObject({ routine_id: null, status: "planned", moved_from: null });
    expect("was_marked" in thu).toBe(false);
    expect(await getDay(FRI)).toMatchObject({ status: "planned", routine_id: pushId, moved_to: null });
  });

  it("undo of a move onto a free date still removes that date's row", async () => {
    await planDay(FRI, pushId);
    await moveDay(FRI, SAT, "busy");
    expect("was_marked" in (await getDay(SAT))!).toBe(false);
    await undoSkip(FRI);
    expect(await getDay(SAT)).toBeUndefined();
    expect(await getDay(FRI)).toMatchObject({ status: "planned", routine_id: pushId });
  });

  it("dragging a moved routine onto a marked date, then undo, restores the mark", async () => {
    await markGymDay(THU);
    await planDay(FRI, pushId);
    await moveDay(FRI, SAT, "busy");
    expect(await rescheduleDay(SAT, THU)).toBe(true);
    expect((await getDay(THU))!.was_marked).toBe(true);
    expect((await getDay(THU))!.moved_from).toBe(FRI);
    expect((await getDay(FRI))!.moved_to).toBe(THU);
    expect(await getDay(SAT)).toBeUndefined();

    await undoSkip(FRI);
    const thu = (await getDay(THU))!;
    expect(thu).toMatchObject({ routine_id: null, status: "planned", moved_from: null });
    expect("was_marked" in thu).toBe(false);
    expect(await getDay(FRI)).toMatchObject({ status: "planned", routine_id: pushId, moved_to: null });
    expect(await db.planned_days.count()).toBe(2);
  });

  it("dragging a moved routine onto a free date, then undo, removes that row", async () => {
    await planDay(FRI, pushId);
    await moveDay(FRI, SAT, "busy");
    expect(await rescheduleDay(SAT, SUN)).toBe(true);
    expect("was_marked" in (await getDay(SUN))!).toBe(false);
    expect((await getDay(FRI))!.moved_to).toBe(SUN);

    await undoSkip(FRI);
    expect(await getDay(SUN)).toBeUndefined();
    expect(await getDay(SAT)).toBeUndefined();
    expect(await getDay(FRI)).toMatchObject({ status: "planned", routine_id: pushId });
  });

  it("dragging off a date that came from a marked date clears the flag on the new free date", async () => {
    await markGymDay(THU);
    await planDay(FRI, pushId);
    await moveDay(FRI, THU, "busy");
    expect(await rescheduleDay(THU, SUN)).toBe(true);
    // THU's row went with the drag; SUN was free, so undo must not leave a mark there.
    expect("was_marked" in (await getDay(SUN))!).toBe(false);
    await undoSkip(FRI);
    expect(await getDay(SUN)).toBeUndefined();
  });
});
