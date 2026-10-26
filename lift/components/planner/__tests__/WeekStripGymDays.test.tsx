// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db, type PlannedDayRow } from "@/lib/offline/db";
import { createRoutine } from "@/lib/routines";
import { getDay, markGymDay, planDay, skipDay, unmarkGymDay } from "@/lib/planner";
import { saveSplit } from "@/lib/splits";
import { autoFillPlan, canDrag, defaultPickedDays, dropAction, isGymDay, markedOpenDates } from "@/lib/autofill";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { WeekStrip, circleClass } from "@/components/planner/WeekStrip";

// WEEK-01: round day circles; tap a date to mark it a gym day (routine optional).
// "Today" is Wednesday 14 Oct 2026; the week is Mon 12 .. Sun 18.
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

const long = (key: string) =>
  `${new Date(key + "T00:00:00").toLocaleDateString(undefined, { weekday: "long" })} ${Number(key.slice(8))}`;
const short = (key: string) => new Date(key + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });

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

async function renderStrip() {
  const r = render(<WeekStrip />);
  await waitFor(() => expect(dayButtons()).toHaveLength(7));
  return r;
}

type Lite = Pick<PlannedDayRow, "routine_id" | "status">;

const outboxFor =async (date: string) =>
  (await db.outbox.toArray()).filter((o) => o.table === "planned_days" && (o.row as { date?: string }).date === date);

describe("day circles: shape and states", () => {
  it("every day is a round button with equal width and height and no box", async () => {
    await renderStrip();
    for (const b of dayButtons()) {
      expect(b).toHaveClass("rounded-full", "h-10", "w-10");
      expect(b.className).not.toMatch(/rounded-xl|rounded-lg|\bw-full\b|px-1|py-2/);
      // The list item around it draws nothing.
      expect(b.parentElement!.className).not.toMatch(/border|bg-|rounded/);
    }
  });

  it("unmarked, today, past and gym day states", async () => {
    await planDay(FRI, pushId);
    await renderStrip();
    // Unmarked future day: thin outline.
    expect(dayButton(THU)).toHaveClass("border", "border-border");
    expect(dayButton(THU)).not.toHaveClass("bg-accent");
    expect(dayButton(THU)).toHaveAttribute("aria-pressed", "false");
    expect(dayButton(THU)).toHaveAccessibleName(`${long(THU)}, not a gym day, tap to mark`);
    // Today unmarked: heavier ring and light fill.
    expect(dayButton(WED)).toHaveClass("border-2", "border-accent", "bg-surface-2");
    // Past: muted, no tap to mark.
    expect(dayButton(MON)).toHaveClass("opacity-50");
    expect(dayButton(MON)).toHaveAccessibleName(`${long(MON)}, not a gym day`);
    // Gym day: solid black with a white number.
    await waitFor(() => expect(dayButton(FRI)).toHaveClass("bg-accent", "text-accent-ink"));
    expect(dayButton(FRI)).toHaveAttribute("aria-pressed", "true");
    expect(dayButton(FRI)).toHaveAccessibleName(`${long(FRI)}, gym day, tap to change`);
  });

  it("circleClass: today and marked has a ring; a drop target is a dashed circle", () => {
    const s = { gym: false, isToday: false, isPast: false, open: false, target: false, over: false, dragging: false };
    expect(circleClass({ ...s, gym: true, isToday: true })).toMatch(/bg-accent.*ring-2/);
    expect(circleClass({ ...s, gym: true })).not.toMatch(/ring-2/);
    expect(circleClass({ ...s, target: true })).toMatch(/border-dashed/);
    expect(circleClass({ ...s, target: true })).toMatch(/rounded-full/);
    expect(circleClass({ ...s, dragging: true })).toMatch(/opacity-40/);
    expect(circleClass(s)).toMatch(/focus-visible:outline/);
  });
});

describe("marking gym days", () => {
  it("tapping an unmarked date marks it (routine null, planned, queued) and opens the panel", async () => {
    await renderStrip();
    fireEvent.click(dayButton(THU));
    await waitFor(async () => expect(await getDay(THU)).toMatchObject({ routine_id: null, status: "planned" }));
    expect(await outboxFor(THU)).toHaveLength(1);
    expect(await screen.findByRole("button", { name: "Gym day: on" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Plan a routine")).toBeInTheDocument();
    await waitFor(() => expect(dayButton(THU)).toHaveClass("bg-accent"));
    // A marked date with no routine shows no planned-routine dot.
    expect(dayButton(THU).textContent).toBe("T15");
    // Other dates are untouched.
    for (const k of WEEK.filter((x) => x !== THU)) expect(await getDay(k)).toBeUndefined();
  });

  it("tapping a marked date only opens the panel", async () => {
    await markGymDay(FRI);
    const before = await getDay(FRI);
    await renderStrip();
    fireEvent.click(dayButton(FRI));
    expect(await screen.findByRole("button", { name: "Gym day: on" })).toBeInTheDocument();
    expect(await getDay(FRI)).toEqual(before);
    expect(await outboxFor(FRI)).toHaveLength(1);
  });

  it("tapping a past date opens the panel without marking", async () => {
    await renderStrip();
    fireEvent.click(dayButton(TUE));
    const toggle = await screen.findByRole("button", { name: "Gym day: off" });
    expect(toggle).toBeDisabled();
    expect(screen.getByText("Past days cannot be marked.")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(await getDay(TUE)).toBeUndefined();
  });

  it("the panel toggle unmarks a routine-less date", async () => {
    await renderStrip();
    fireEvent.click(dayButton(SAT));
    fireEvent.click(await screen.findByRole("button", { name: "Gym day: on" }));
    await waitFor(async () => expect(await getDay(SAT)).toBeUndefined());
    expect(await screen.findByRole("button", { name: "Gym day: off" })).toBeInTheDocument();
    await waitFor(() => expect(dayButton(SAT)).not.toHaveClass("bg-accent"));
    const ops = (await db.outbox.toArray()).filter((o) => o.table === "planned_days").map((o) => o.op);
    expect(ops).toEqual(["upsert", "delete"]);
  });

  it("toggling back on re-marks the date", async () => {
    await renderStrip();
    fireEvent.click(dayButton(SAT));
    fireEvent.click(await screen.findByRole("button", { name: "Gym day: on" }));
    fireEvent.click(await screen.findByRole("button", { name: "Gym day: off" }));
    await waitFor(async () => expect(await getDay(SAT)).toMatchObject({ routine_id: null, status: "planned" }));
  });

  it("unmarking a date with a routine asks first and removes both", async () => {
    await planDay(THU, pushId);
    const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await renderStrip();
    fireEvent.click(dayButton(THU));
    const toggle = await screen.findByRole("button", { name: "Gym day: on" });

    fireEvent.click(toggle);
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask.mock.calls[0][0]).toContain("Push");
    expect(await getDay(THU)).toMatchObject({ routine_id: pushId });

    fireEvent.click(toggle);
    await waitFor(async () => expect(await getDay(THU)).toBeUndefined());
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("done, skipped and moved dates cannot be unmarked", async () => {
    await planDay(WED, pushId);
    await db.planned_days.update((await getDay(WED))!.id, { status: "done", workout_id: "w1" });
    await planDay(THU, pushId);
    await skipDay(THU, "busy");
    await renderStrip();

    fireEvent.click(dayButton(WED));
    expect(await screen.findByRole("button", { name: "Gym day: on" })).toBeDisabled();
    expect(screen.getByText("Trained days stay marked.")).toBeInTheDocument();

    fireEvent.click(dayButton(THU));
    expect(await screen.findByRole("button", { name: "Gym day: off" })).toBeDisabled();
    expect(dayButton(THU)).toHaveAccessibleName(`${long(THU)}, skipped, tap to change`);
    expect(await unmarkGymDay(THU)).toBe(false);
    expect(await getDay(THU)).toMatchObject({ status: "skipped" });
    expect(await getDay(WED)).toMatchObject({ status: "done" });
  });

  it("planning a routine on a marked date keeps the same row and adds the dot", async () => {
    await renderStrip();
    fireEvent.click(dayButton(FRI));
    await waitFor(async () => expect(await getDay(FRI)).toBeDefined());
    const id = (await getDay(FRI))!.id;
    fireEvent.click(await screen.findByRole("button", { name: "Push" }));
    await waitFor(async () => expect(await getDay(FRI)).toMatchObject({ id, routine_id: pushId, status: "planned" }));
    await waitFor(() => expect(dayButton(FRI).textContent).toContain("•"));
  });

  it("marks persist across a remount", async () => {
    const first = await renderStrip();
    fireEvent.click(dayButton(SUN));
    await waitFor(async () => expect(await getDay(SUN)).toBeDefined());
    first.unmount();
    await renderStrip();
    await waitFor(() => expect(dayButton(SUN)).toHaveAttribute("aria-pressed", "true"));
  });

  it("a routine-less gym day is not draggable and shows no drag hint", async () => {
    await markGymDay(THU);
    await renderStrip();
    await waitFor(() => expect(dayButton(THU)).toHaveClass("bg-accent"));
    expect(screen.queryByText("Drag a planned day to move it.")).not.toBeInTheDocument();
  });
});

describe("planner and auto-fill rules with routine-less marks", () => {
  it("markGymDay never overwrites an existing row; unmarkGymDay ignores missing dates", async () => {
    await planDay(THU, pushId);
    expect(await markGymDay(THU)).toBe(false);
    expect(await getDay(THU)).toMatchObject({ routine_id: pushId });
    expect(await markGymDay(FRI)).toBe(true);
    expect(await unmarkGymDay(SAT)).toBe(false);
  });

  it("canDrag, dropAction and isGymDay", () => {
    const mark: Lite = { routine_id: null, status: "planned" };
    const push: Lite = { routine_id: "p", status: "planned" };
    const plan = new Map<string, Lite>([
      [THU, mark],
      [WED, push],
    ]);
    expect(canDrag(mark)).toBe(false);
    expect(dropAction(THU, FRI, plan, WED)).toBeNull();
    // A routine can be dropped onto a routine-less gym day (it is free).
    expect(dropAction(WED, THU, plan, WED)).toBe("move");
    expect(isGymDay(mark)).toBe(true);
    expect(isGymDay({ status: "done" })).toBe(true);
    expect(isGymDay({ status: "skipped" })).toBe(false);
    expect(isGymDay({ status: "moved" })).toBe(false);
    expect(isGymDay(undefined)).toBe(false);
  });

  it("markedOpenDates and defaultPickedDays", () => {
    const plan = new Map<string, Lite>([
      [MON, { routine_id: null, status: "planned" as const }],
      [THU, { routine_id: null, status: "planned" as const }],
      [SAT, { routine_id: "p", status: "planned" as const }],
    ]);
    expect(markedOpenDates(WEEK, plan, WED)).toEqual([THU]);
    expect(defaultPickedDays([THU], 3)).toEqual([4]);
    expect(defaultPickedDays([], 3)).toEqual([1, 3, 5]);
  });

  it("autoFillPlan fills marked dates first in split order, then the others", () => {
    const plan = new Map([[SAT, { routine_id: null, status: "planned" as const }]]);
    // Picked Thu and Sat; Sat is marked so it gets the first routine.
    const out = autoFillPlan({ days: WEEK, gymDays: [4, 6], plan, today: WED, routineIds: ["a", "b"], marked: [SAT] });
    expect(out).toEqual([
      { date: THU, routine_id: "b" },
      { date: SAT, routine_id: "a" },
    ]);
    // Without marks it behaves as before.
    expect(autoFillPlan({ days: WEEK, gymDays: [4, 6], plan: new Map(), today: WED, routineIds: ["a", "b"] })).toEqual([
      { date: THU, routine_id: "a" },
      { date: SAT, routine_id: "b" },
    ]);
  });

  it("Auto-fill defaults its picker to the marked dates and fills them", async () => {
    await saveSplit({ name: "PP", days: [{ name: "Push", muscles: [] }, { name: "Pull", muscles: [] }] });
    await markGymDay(THU);
    await markGymDay(SAT);
    await renderStrip();
    fireEvent.click(screen.getByRole("button", { name: "Auto-fill from my split" }));
    expect(await screen.findByText("Order: Push, Pull")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: short(THU) })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: short(SAT) })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: short(FRI) })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Fill 2 days" }));
    await waitFor(async () => expect(await getDay(SAT)).toMatchObject({ routine_id: pullId }));
    expect(await getDay(THU)).toMatchObject({ routine_id: pushId });
    expect(await getDay(FRI)).toBeUndefined();
  });
});
