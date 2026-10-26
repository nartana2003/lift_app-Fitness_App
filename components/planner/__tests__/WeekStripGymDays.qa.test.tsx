// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { createRoutine } from "@/lib/routines";
import {
  clearDay,
  getDay,
  markGymDay,
  moveDay,
  moveOptions,
  planDay,
  rescheduleDay,
  skipDay,
  swapDays,
  undoSkip,
  unmarkGymDay,
  weekDays,
} from "@/lib/planner";
import { autoFillPlan, canDrag, dropAction, isGymDay } from "@/lib/autofill";
import { skipStats } from "@/lib/progress";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { WeekStrip, circleClass } from "@/components/planner/WeekStrip";

// QA for WEEK-01. "Today" is Wednesday 14 Oct 2026; the week is Mon 12 .. Sun 18.
const NOW = new Date(2026, 9, 14, 12, 0, 0);
const MON = "2026-10-12";
const TUE = "2026-10-13";
const WED = "2026-10-14";
const THU = "2026-10-15";
const FRI = "2026-10-16";
const SAT = "2026-10-17";
const SUN = "2026-10-18";
const WEEK = [MON, TUE, WED, THU, FRI, SAT, SUN];
const IDX: Record<string, number> = Object.fromEntries(WEEK.map((k, i) => [k, i]));

let pushId = "";
let pullId = "";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await Promise.all(db.tables.map((t) => t.clear()));
  pushId = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench" }] });
  vi.setSystemTime(new Date(2026, 9, 14, 12, 0, 1));
  pullId = await createRoutine({ name: "Pull", exercises: [{ exercise_id: "row" }] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const dayButtons = () => within(screen.getByRole("list")).getAllByRole("button");
const dayButton = (key: string) => dayButtons()[IDX[key]];
const rowsFor = async (date: string) => (await db.planned_days.toArray()).filter((r) => r.date === date);

async function renderStrip() {
  const r = render(<WeekStrip />);
  await waitFor(() => expect(dayButtons()).toHaveLength(7));
  return r;
}

describe("QA circle shape", () => {
  it("exactly seven day buttons, one per list item, none nested", async () => {
    await renderStrip();
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(7);
    for (const li of items) {
      expect(within(li).getAllByRole("button")).toHaveLength(1);
      expect(li.querySelector("button button")).toBeNull();
    }
  });

  it("circleClass is a fully round fixed square with no box classes for every state combination", () => {
    const bools = [false, true];
    for (const gym of bools)
      for (const isToday of bools)
        for (const isPast of bools)
          for (const open of bools)
            for (const target of bools)
              for (const over of bools)
                for (const dragging of bools) {
                  const c = circleClass({ gym, isToday, isPast, open, target, over, dragging });
                  const t = c.split(/\s+/);
                  expect(t).toContain("rounded-full");
                  expect(t).toContain("h-10");
                  expect(t).toContain("w-10");
                  expect(t.filter((x) => /^rounded(-|$)/.test(x) && x !== "rounded-full")).toEqual([]);
                  expect(t.some((x) => /^(p|px|py|w-full|aspect)/.test(x))).toBe(false);
                  expect(t.some((x) => /green|pink|emerald|rose|red|blue/.test(x))).toBe(false);
                }
  });

  it("list items stay free of border, background and rounding in every state", async () => {
    await planDay(FRI, pushId);
    await markGymDay(THU);
    await skipDay(SAT, "busy");
    await renderStrip();
    await waitFor(() => expect(dayButton(THU)).toHaveClass("bg-accent"));
    fireEvent.click(dayButton(WED));
    for (const li of within(screen.getByRole("list")).getAllByRole("listitem")) {
      expect(li.className).not.toMatch(/border|bg-|rounded|shadow|ring/);
    }
  });

  it("marked dates never use an accent other than black (bg-accent) and keep a white number", async () => {
    await markGymDay(THU);
    await renderStrip();
    await waitFor(() => expect(dayButton(THU)).toHaveClass("bg-accent", "text-accent-ink"));
  });
});

describe("QA marking rules", () => {
  it("tapping today (boundary) marks it", async () => {
    await renderStrip();
    fireEvent.click(dayButton(WED));
    await waitFor(async () => expect(await getDay(WED)).toMatchObject({ routine_id: null, status: "planned" }));
    // The row commits before the live query re-renders the strip, so wait for the UI too.
    await waitFor(() => expect(dayButton(WED)).toHaveClass("bg-accent", "ring-2"));
  });

  it("tapping every past date never writes a row, even when tapped repeatedly", async () => {
    await renderStrip();
    for (const k of [MON, TUE]) {
      fireEvent.click(dayButton(k));
      fireEvent.click(dayButton(k));
      fireEvent.click(dayButton(k));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(await db.planned_days.count()).toBe(0);
    expect((await db.outbox.toArray()).filter((o) => o.table === "planned_days")).toEqual([]);
  });

  it("the Gym day toggle is disabled for an unmarked past date and clicking it does nothing", async () => {
    await renderStrip();
    fireEvent.click(dayButton(MON));
    const toggle = await screen.findByRole("button", { name: "Gym day: off" });
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    await new Promise((r) => setTimeout(r, 30));
    expect(await db.planned_days.count()).toBe(0);
  });

  it("a marked past date (seeded) can still be opened and unmarked while it is routine-less", async () => {
    await markGymDay(MON);
    await renderStrip();
    await waitFor(() => expect(dayButton(MON)).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(dayButton(MON));
    fireEvent.click(await screen.findByRole("button", { name: "Gym day: on" }));
    await waitFor(async () => expect(await getDay(MON)).toBeUndefined());
  });

  it("aria-label and aria-pressed follow mark -> unmark and the other dates do not change", async () => {
    await renderStrip();
    const before = dayButtons().map((b) => b.getAttribute("aria-label"));
    fireEvent.click(dayButton(FRI));
    await waitFor(() => expect(dayButton(FRI)).toHaveAttribute("aria-pressed", "true"));
    expect(dayButton(FRI).getAttribute("aria-label")).toMatch(/16, gym day, tap to change$/);
    const mid = dayButtons().map((b) => b.getAttribute("aria-label"));
    mid.forEach((l, i) => {
      if (i !== IDX[FRI]) expect(l).toBe(before[i]);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Gym day: on" }));
    await waitFor(() => expect(dayButton(FRI)).toHaveAttribute("aria-pressed", "false"));
    expect(dayButtons().map((b) => b.getAttribute("aria-label"))).toEqual(before);
  });

  it("skipped and moved dates are not pressed and say so in the label", async () => {
    await planDay(THU, pushId);
    await skipDay(THU, "tired");
    await planDay(FRI, pullId);
    await moveDay(FRI, SAT, "busy");
    await renderStrip();
    await waitFor(() => expect(dayButton(THU).getAttribute("aria-label")).toMatch(/skipped, tap to change$/));
    expect(dayButton(THU)).toHaveAttribute("aria-pressed", "false");
    expect(dayButton(FRI).getAttribute("aria-label")).toMatch(/moved, tap to change$/);
    expect(dayButton(FRI)).toHaveAttribute("aria-pressed", "false");
    expect(dayButton(SAT)).toHaveAttribute("aria-pressed", "true");
  });

  it("marking two dates then unmarking one leaves the other (per date, not per weekday)", async () => {
    await renderStrip();
    fireEvent.click(dayButton(THU));
    await waitFor(() => expect(dayButton(THU)).toHaveClass("bg-accent"));
    fireEvent.click(dayButton(SAT));
    await waitFor(() => expect(dayButton(SAT)).toHaveClass("bg-accent"));
    fireEvent.click(await screen.findByRole("button", { name: "Gym day: on" })); // panel is for SAT
    await waitFor(() => expect(dayButton(SAT)).not.toHaveClass("bg-accent"));
    expect(dayButton(THU)).toHaveClass("bg-accent");
    expect(await getDay(THU)).toBeDefined();
    expect(await getDay(SAT)).toBeUndefined();
    // A mark on Thursday of this week is not a mark on any other Thursday.
    expect((await db.planned_days.toArray()).map((r) => r.date)).toEqual([THU]);
  });

  it("confirm dialog cancelled keeps the routine and the mark", async () => {
    await planDay(THU, pushId);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderStrip();
    fireEvent.click(dayButton(THU));
    fireEvent.click(await screen.findByRole("button", { name: "Gym day: on" }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(await getDay(THU)).toMatchObject({ routine_id: pushId });
  });

  it("a routine-less unmark never asks to confirm", async () => {
    await markGymDay(THU);
    const c = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderStrip();
    await waitFor(() => expect(dayButton(THU)).toHaveClass("bg-accent"));
    fireEvent.click(dayButton(THU));
    fireEvent.click(await screen.findByRole("button", { name: "Gym day: on" }));
    await waitFor(async () => expect(await getDay(THU)).toBeUndefined());
    expect(c).not.toHaveBeenCalled();
  });

  it("done, skipped and moved dates: toggle disabled and clicking it changes nothing", async () => {
    await planDay(THU, pushId);
    await db.planned_days.update((await getDay(THU))!.id, { status: "done", workout_id: "w1" });
    await planDay(FRI, pushId);
    await skipDay(FRI, "sick");
    await planDay(SAT, pullId);
    await moveDay(SAT, SUN, "busy");
    await renderStrip();
    for (const k of [THU, FRI, SAT]) {
      const label = dayButton(k).getAttribute("aria-label");
      fireEvent.click(dayButton(k));
      const toggle = await screen.findByRole("button", { name: /Gym day: (on|off)/ });
      expect(toggle, label ?? "").toBeDisabled();
      fireEvent.click(toggle);
      fireEvent.click(dayButton(k)); // close
    }
    await new Promise((r) => setTimeout(r, 30));
    expect((await getDay(THU))?.status).toBe("done");
    expect((await getDay(FRI))?.status).toBe("skipped");
    expect((await getDay(SAT))?.status).toBe("moved");
  });

  it("tapping a skipped past/future date never turns it into a fresh mark", async () => {
    await planDay(THU, pushId);
    await skipDay(THU, "busy");
    await renderStrip();
    fireEvent.click(dayButton(THU));
    await new Promise((r) => setTimeout(r, 30));
    expect((await getDay(THU))?.status).toBe("skipped");
    expect(await db.planned_days.count()).toBe(1);
  });
});

describe("QA data layer: unique date index", () => {
  it("marking the same date many times at once writes exactly one row and never throws", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => markGymDay(THU)));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await rowsFor(THU)).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled" && r.value === true)).toHaveLength(1);
  });

  it("marking while a routine is being planned at the same time leaves one row", async () => {
    const results = await Promise.allSettled([markGymDay(THU), planDay(THU, pushId), markGymDay(THU)]);
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await rowsFor(THU)).toHaveLength(1);
  });

  it("mark, unmark, mark leaves a single row and the outbox ends consistent", async () => {
    await markGymDay(THU);
    await unmarkGymDay(THU);
    await markGymDay(THU);
    expect(await rowsFor(THU)).toHaveLength(1);
    const ops = (await db.outbox.toArray()).filter((o) => o.table === "planned_days").map((o) => o.op);
    expect(ops).toEqual(["upsert", "delete", "upsert"]);
  });

  it("unmarkGymDay on a missing, done, skipped or moved date returns false and keeps the data", async () => {
    expect(await unmarkGymDay(THU)).toBe(false);
    await planDay(FRI, pushId);
    await skipDay(FRI, "busy");
    expect(await unmarkGymDay(FRI)).toBe(false);
    await planDay(SAT, pushId);
    await moveDay(SAT, SUN, "busy");
    expect(await unmarkGymDay(SAT)).toBe(false);
    expect(await db.planned_days.count()).toBe(3);
  });
});

describe("QA routine-less marked dates next to routine days", () => {
  it("canDrag, dropAction, isGymDay with routine-less rows", () => {
    const plan = new Map([
      [THU, { routine_id: null, status: "planned" as const }],
      [FRI, { routine_id: "r", status: "planned" as const }],
    ]);
    expect(canDrag(plan.get(THU))).toBe(false);
    expect(dropAction(THU, FRI, plan, WED)).toBeNull();
    expect(dropAction(FRI, THU, plan, WED)).toBe("move"); // a marked, empty date is free to receive
    expect(isGymDay(plan.get(THU))).toBe(true);
  });

  it("rescheduleDay onto a routine-less marked date moves the routine and keeps one row for it", async () => {
    await markGymDay(THU);
    await planDay(FRI, pushId);
    expect(await rescheduleDay(FRI, THU)).toBe(true);
    expect(await getDay(FRI)).toBeUndefined();
    expect(await getDay(THU)).toMatchObject({ routine_id: pushId, status: "planned" });
    expect(await db.planned_days.count()).toBe(1);
  });

  it("a routine-less marked date cannot be the source of a reschedule or swap", async () => {
    await markGymDay(THU);
    await planDay(FRI, pushId);
    expect(await rescheduleDay(THU, SAT)).toBe(false);
    expect(await swapDays(THU, FRI)).toBe(false);
    expect(await swapDays(FRI, THU)).toBe(false);
    expect(await getDay(THU)).toMatchObject({ routine_id: null });
    expect(await getDay(FRI)).toMatchObject({ routine_id: pushId });
  });

  it("moveOptions offers routine-less marked dates but not routine or done dates", async () => {
    await markGymDay(THU);
    await planDay(FRI, pushId);
    const rows = new Map((await db.planned_days.toArray()).map((r) => [r.date, r]));
    const opts = moveOptions(weekDays(1, NOW), rows, WED, NOW).map((d) => d.getDate());
    expect(opts).toContain(15);
    expect(opts).not.toContain(16);
  });

  it("moving a routine onto a marked date, then dragging nothing, keeps the other marks", async () => {
    await markGymDay(THU);
    await markGymDay(SAT);
    await planDay(FRI, pushId);
    await moveDay(FRI, THU, "busy");
    expect(await getDay(THU)).toMatchObject({ routine_id: pushId, status: "planned", moved_from: FRI });
    expect(await getDay(SAT)).toMatchObject({ routine_id: null, status: "planned" });
  });

  it("the panel of a routine-less marked date offers Plan a routine and no Skip, Move or Start", async () => {
    await markGymDay(THU);
    await planDay(FRI, pushId);
    await renderStrip();
    await waitFor(() => expect(dayButton(THU)).toHaveClass("bg-accent"));
    fireEvent.click(dayButton(THU));
    expect(await screen.findByText("Plan a routine")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    // Planning from the panel keeps it the same marked date.
    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    await waitFor(async () => expect(await getDay(THU)).toMatchObject({ routine_id: pullId, status: "planned" }));
    expect(await rowsFor(THU)).toHaveLength(1);
  });

  it("skip then undo on a routine day beside a routine-less mark leaves the mark alone", async () => {
    await markGymDay(THU);
    await planDay(FRI, pushId);
    await skipDay(FRI, "tired");
    await undoSkip(FRI);
    expect(await getDay(FRI)).toMatchObject({ routine_id: pushId, status: "planned" });
    expect(await getDay(THU)).toMatchObject({ routine_id: null, status: "planned" });
  });

  it("move then undo into a FREE date removes that destination (existing behaviour kept)", async () => {
    await planDay(FRI, pushId);
    await moveDay(FRI, SAT, "busy");
    await undoSkip(FRI);
    expect(await getDay(SAT)).toBeUndefined();
    expect(await getDay(FRI)).toMatchObject({ status: "planned", routine_id: pushId });
  });

  it("BUG CHECK: undoing a move onto a date the user had marked keeps the mark", async () => {
    await markGymDay(THU);
    await planDay(FRI, pushId);
    await moveDay(FRI, THU, "busy");
    await undoSkip(FRI);
    expect(await getDay(FRI)).toMatchObject({ status: "planned", routine_id: pushId });
    // The Thursday mark must come back as a routine-less gym day, not vanish.
    expect(await getDay(THU)).toMatchObject({ routine_id: null, status: "planned" });
  });

  it("clearDay on a routine day leaves neighbouring marks", async () => {
    await markGymDay(THU);
    await planDay(FRI, pushId);
    await clearDay(FRI);
    expect(await getDay(THU)).toBeDefined();
    expect(await db.planned_days.count()).toBe(1);
  });

  it("skipStats ignores routine-less marked and planned dates", () => {
    const rows = [
      { date: THU, status: "planned" as const, skip_reason: null },
      { date: FRI, status: "planned" as const, skip_reason: null },
      { date: SAT, status: "skipped" as const, skip_reason: "busy" as const },
    ];
    const s = skipStats(rows, new Date(2026, 9, 12), new Date(2026, 9, 19));
    expect(s).toMatchObject({ skipped: 1, moved: 0 });
    expect(skipStats(rows.slice(0, 2), new Date(2026, 9, 12), new Date(2026, 9, 19))).toEqual({ skipped: 0, moved: 0, topReasons: [] });
  });

  it("skipStats on real marked rows from the database counts zero", async () => {
    await markGymDay(THU);
    await markGymDay(FRI);
    const rows = await db.planned_days.toArray();
    expect(skipStats(rows, new Date(2026, 9, 12), new Date(2026, 9, 19)).skipped).toBe(0);
  });
});

describe("QA auto-fill with marks", () => {
  it("never fills past marked dates and never overwrites a routine day or a done marked day", () => {
    const plan = new Map([
      [MON, { routine_id: null, status: "planned" as const }],
      [THU, { routine_id: null, status: "planned" as const }],
      [FRI, { routine_id: "x", status: "planned" as const }],
      [SAT, { routine_id: null, status: "done" as const }],
    ]);
    const out = autoFillPlan({
      days: WEEK,
      gymDays: [1, 4, 5, 6],
      plan,
      today: WED,
      routineIds: ["a", "b"],
      marked: [THU],
    });
    expect(out.map((f) => f.date)).toEqual([THU]);
    expect(out[0].routine_id).toBe("a");
  });

  it("with several marks, the first routine goes to the earliest marked date, extra picked days follow", () => {
    const plan = new Map([
      [SAT, { routine_id: null, status: "planned" as const }],
      [THU, { routine_id: null, status: "planned" as const }],
    ]);
    const out = autoFillPlan({ days: WEEK, gymDays: [4, 5, 6], plan, today: WED, routineIds: ["a", "b", "c"], marked: [THU, SAT] });
    expect(out).toEqual([
      { date: THU, routine_id: "a" },
      { date: FRI, routine_id: "c" },
      { date: SAT, routine_id: "b" },
    ]);
  });

  it("the panel Auto-fill fills a marked date and leaves the unmarked Friday alone by default", async () => {
    await markGymDay(THU);
    await renderStrip();
    await waitFor(() => expect(dayButton(THU)).toHaveClass("bg-accent"));
    fireEvent.click(screen.getByRole("button", { name: "Auto-fill from my split" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Fill 1 day$/ }));
    await waitFor(async () => expect((await getDay(THU))?.routine_id).toBeTruthy());
    expect(await getDay(FRI)).toBeUndefined();
    expect(await rowsFor(THU)).toHaveLength(1);
  });
});

describe("QA no errors", () => {
  it("mark / open / unmark / close flows raise no console errors or unhandled rejections", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const rej: unknown[] = [];
    const onRej = (e: unknown) => rej.push(e);
    process.on("unhandledRejection", onRej);
    await renderStrip();
    for (const k of [MON, THU, THU, THU, FRI, FRI, SAT]) fireEvent.click(dayButton(k));
    await new Promise((r) => setTimeout(r, 100));
    process.off("unhandledRejection", onRej);
    expect(rej).toEqual([]);
    expect(err).not.toHaveBeenCalled();
  });
});
