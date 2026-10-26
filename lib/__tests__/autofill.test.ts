import { describe, expect, it } from "vitest";
import { autoFillPlan, canDrag, defaultGymDays, dropAction, splitRoutineOrder, weekdayOf } from "../autofill";
import type { PlannedDayRow, RoutineRow } from "../offline/db";

// Week of Mon 12 .. Sun 18 Oct 2026; "today" is Wednesday 14.
const WEEK = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
const [MON, TUE, WED, THU, FRI, SAT, SUN] = WEEK;
const TODAY = WED;

type R = Pick<RoutineRow, "id" | "name" | "day_label" | "created_at" | "kind">;
const r = (id: string, name: string, created_at: string, p: Partial<R> = {}): R => ({
  id,
  name,
  day_label: null,
  created_at,
  kind: "routine",
  ...p,
});

type P = Pick<PlannedDayRow, "routine_id" | "status">;
const planned = (routine_id: string): P => ({ routine_id, status: "planned" });
const plan = (entries: Record<string, P> = {}) => new Map(Object.entries(entries));

const split = (...names: string[]) => ({ days: names.map((name) => ({ name, muscles: [] })) });

describe("weekdayOf", () => {
  it("reads the local weekday of a date key", () => {
    expect(WEEK.map(weekdayOf)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });
});

describe("defaultGymDays", () => {
  it("spreads sessions across the week", () => {
    expect(defaultGymDays(1)).toEqual([1]);
    expect(defaultGymDays(2)).toEqual([1, 4]);
    expect(defaultGymDays(3)).toEqual([1, 3, 5]);
    expect(defaultGymDays(4)).toEqual([1, 2, 4, 5]);
    expect(defaultGymDays(6)).toHaveLength(6);
  });

  it("clamps silly values", () => {
    expect(defaultGymDays(0)).toEqual([1, 3, 5]);
    expect(defaultGymDays(-4)).toEqual([1, 3, 5]);
    expect(defaultGymDays(12)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("splitRoutineOrder", () => {
  const routines = [
    r("legs", "Leg day", "2026-01-03"),
    r("push", "Push", "2026-01-01"),
    r("pull", "Back & biceps", "2026-01-02", { day_label: "Pull" }),
    r("abs", "Push", "2026-01-04", { kind: "mini" }),
  ];

  it("follows the split, matching by day label, exact name, then partial name", () => {
    expect(splitRoutineOrder(split("Push", "Pull", "Legs"), routines)).toEqual(["push", "pull", "legs"]);
  });

  it("is case and space insensitive", () => {
    expect(splitRoutineOrder(split("  PUSH ", "pull"), routines)).toEqual(["push", "pull"]);
  });

  it("skips split days with no routine", () => {
    expect(splitRoutineOrder(split("Push", "Cardio", "Legs"), routines)).toEqual(["push", "legs"]);
  });

  it("uses every full routine oldest first when there is no split", () => {
    expect(splitRoutineOrder(split(), routines)).toEqual(["push", "pull", "legs"]);
  });

  it("falls back to every routine when nothing in the split matches", () => {
    expect(splitRoutineOrder(split("Cardio", ""), routines)).toEqual(["push", "pull", "legs"]);
  });

  it("does not confuse days that share only some words", () => {
    const ab = [r("b", "Full body B", "2026-01-01"), r("a", "Full body A", "2026-01-02")];
    expect(splitRoutineOrder(split("Full body A", "Full body B"), ab)).toEqual(["a", "b"]);
  });

  it("never uses mini routines", () => {
    expect(splitRoutineOrder(split(), [r("abs", "Abs", "2026-01-01", { kind: "mini" })])).toEqual([]);
  });
});

describe("autoFillPlan", () => {
  const base = { days: WEEK, today: TODAY, routineIds: ["push", "pull", "legs"] };

  it("fills chosen gym days from today on, cycling the split", () => {
    const out = autoFillPlan({ ...base, gymDays: [1, 3, 4, 5, 6], plan: plan() });
    // Monday is past, so it starts on Wednesday.
    expect(out).toEqual([
      { date: WED, routine_id: "push" },
      { date: THU, routine_id: "pull" },
      { date: FRI, routine_id: "legs" },
      { date: SAT, routine_id: "push" },
    ]);
  });

  it("leaves planned, done and skipped days alone", () => {
    const out = autoFillPlan({
      ...base,
      gymDays: [3, 4, 5, 6, 0],
      plan: plan({
        [WED]: planned("x"),
        [THU]: { routine_id: null, status: "done" },
        [FRI]: { routine_id: "y", status: "skipped" },
        [SAT]: { routine_id: null, status: "planned" }, // empty row counts as free
      }),
    });
    expect(out).toEqual([
      { date: SAT, routine_id: "push" },
      { date: SUN, routine_id: "pull" },
    ]);
  });

  it("returns nothing with no routines or no gym days", () => {
    expect(autoFillPlan({ ...base, routineIds: [], gymDays: [3], plan: plan() })).toEqual([]);
    expect(autoFillPlan({ ...base, gymDays: [], plan: plan() })).toEqual([]);
    expect(autoFillPlan({ ...base, gymDays: [1, 2], plan: plan() })).toEqual([]); // Mon, Tue are past
  });
});

describe("dropAction", () => {
  it("moves a planned day to a free day from today on", () => {
    expect(dropAction(WED, FRI, plan({ [WED]: planned("push") }), TODAY)).toBe("move");
    expect(dropAction(MON, THU, plan({ [MON]: planned("push") }), TODAY)).toBe("move");
  });

  it("swaps two planned days when both are from today on", () => {
    expect(dropAction(WED, FRI, plan({ [WED]: planned("push"), [FRI]: planned("legs") }), TODAY)).toBe("swap");
    expect(dropAction(TUE, FRI, plan({ [TUE]: planned("push"), [FRI]: planned("legs") }), TODAY)).toBeNull();
  });

  it("rejects past targets, the same day, and days that are not planned", () => {
    const p = plan({
      [WED]: planned("push"),
      [THU]: { routine_id: "a", status: "done" },
      [FRI]: { routine_id: "b", status: "skipped" },
      [SAT]: { routine_id: "c", status: "moved" },
    });
    expect(dropAction(WED, MON, p, TODAY)).toBeNull();
    expect(dropAction(WED, WED, p, TODAY)).toBeNull();
    expect(dropAction(WED, THU, p, TODAY)).toBeNull();
    expect(dropAction(WED, FRI, p, TODAY)).toBeNull();
    expect(dropAction(WED, SAT, p, TODAY)).toBeNull();
    expect(dropAction(THU, SUN, p, TODAY)).toBeNull();
    expect(dropAction(SUN, MON, p, TODAY)).toBeNull();
  });
});

describe("canDrag", () => {
  it("only lets planned days with a routine be picked up", () => {
    expect(canDrag(planned("push"))).toBe(true);
    expect(canDrag(undefined)).toBe(false);
    expect(canDrag({ routine_id: null, status: "planned" })).toBe(false);
    expect(canDrag({ routine_id: "push", status: "done" })).toBe(false);
    expect(canDrag({ routine_id: "push", status: "skipped" })).toBe(false);
  });
});

describe("splitRoutineOrder with routines linked to split days", () => {
  type L = R & { split_day_id?: string | null };
  const lr = (id: string, name: string, created_at: string, p: Partial<L> = {}): L => ({ ...r(id, name, created_at), ...p });
  const linkedSplit = { days: [{ id: "d-push", name: "Push", muscles: [] }, { id: "d-pull", name: "Pull", muscles: [] }, { id: "d-legs", name: "Legs", muscles: [] }] };

  it("uses the linked routine over a name match", () => {
    const routines = [
      lr("push-named", "Push", "2026-01-01"),
      lr("my-chest", "Chest blast", "2026-01-02", { split_day_id: "d-push" }),
      lr("pull", "Pull", "2026-01-03"),
      lr("legs", "Legs", "2026-01-04"),
    ];
    expect(splitRoutineOrder(linkedSplit, routines)).toEqual(["my-chest", "pull", "legs"]);
  });

  it("falls back to name matching for days with no link, skipping routines linked to another day", () => {
    // "Pull" by name is linked to Legs, so the Pull day finds nothing by name.
    const routines = [lr("pull-named", "Pull", "2026-01-01", { split_day_id: "d-legs" }), lr("push", "Push", "2026-01-02")];
    expect(splitRoutineOrder(linkedSplit, routines)).toEqual(["push", "pull-named"]);
  });

  it("picks the routine done longest ago when a day has several, oldest first on a tie", () => {
    const routines = [
      lr("a", "Push A", "2026-01-01", { split_day_id: "d-push" }),
      lr("b", "Push B", "2026-01-02", { split_day_id: "d-push" }),
    ];
    const one = { days: [linkedSplit.days[0]] };
    expect(splitRoutineOrder(one, routines)).toEqual(["a"]);
    expect(splitRoutineOrder(one, routines, new Map([["a", "2026-02-01T10:00:00Z"]]))).toEqual(["b"]);
    expect(splitRoutineOrder(one, routines, new Map([["a", "2026-02-01T10:00:00Z"], ["b", "2026-03-01T10:00:00Z"]]))).toEqual(["a"]);
  });

  it("never picks a linked mini routine, and ignores links to days no longer in the split", () => {
    const routines = [
      lr("mini", "Push", "2026-01-01", { kind: "mini", split_day_id: "d-push" }),
      lr("gone", "Push", "2026-01-02", { split_day_id: "removed-day" }),
    ];
    expect(splitRoutineOrder(linkedSplit, routines)).toEqual(["gone"]);
  });

  it("days without ids (legacy splits) behave exactly as before", () => {
    const routines = [lr("push", "Push", "2026-01-01", { split_day_id: "d-push" }), lr("legs", "Leg day", "2026-01-02")];
    expect(splitRoutineOrder(split("Push", "Legs"), routines)).toEqual(["push", "legs"]);
  });
});
