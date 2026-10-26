// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { createRoutine } from "@/lib/routines";
import { getDay, planDay } from "@/lib/planner";
import { saveSplit } from "@/lib/splits";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { WeekStrip } from "@/components/planner/WeekStrip";

// FEAT-03: drag a planned day to reschedule it, and auto-fill the week from the split.
// "Today" is Wednesday 14 Oct 2026; the week is Mon 12 .. Sun 18.
const NOW = new Date(2026, 9, 14, 12, 0, 0);
const MON = "2026-10-12";
const WED = "2026-10-14";
const THU = "2026-10-15";
const FRI = "2026-10-16";
const SAT = "2026-10-17";
const SUN = "2026-10-18";
const IDX: Record<string, number> = { [MON]: 0, [WED]: 2, [THU]: 3, [FRI]: 4, [SAT]: 5, [SUN]: 6 };

const short = (key: string) => new Date(key + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });

let pushId = "";
let pullId = "";
let legsId = "";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await Promise.all(db.tables.map((t) => t.clear()));
  pushId = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench" }] });
  vi.setSystemTime(new Date(2026, 9, 14, 12, 0, 1));
  pullId = await createRoutine({ name: "Pull", exercises: [{ exercise_id: "row" }] });
  vi.setSystemTime(new Date(2026, 9, 14, 12, 0, 2));
  legsId = await createRoutine({ name: "Legs", exercises: [{ exercise_id: "squat" }] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  // @ts-expect-error test-only stub cleanup
  delete document.elementFromPoint;
});

const dayButtons = () => within(screen.getByRole("list")).getAllByRole("button");
const dayButton = (key: string) => dayButtons()[IDX[key]];

async function renderStrip() {
  render(<WeekStrip />);
  await waitFor(() => expect(dayButtons()).toHaveLength(7));
}

/** Simulate a pointer drag from one day cell to another. */
function dragDay(from: string, to: string) {
  const src = dayButton(from);
  const dst = dayButton(to);
  document.elementFromPoint = vi.fn(() => dst);
  fireEvent.pointerDown(src, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(src, { pointerId: 1, clientX: 60, clientY: 10 });
  fireEvent.pointerUp(src, { pointerId: 1, clientX: 60, clientY: 10 });
}

describe("WeekStrip drag to reschedule", () => {
  it("hints that planned days can be dragged", async () => {
    await renderStrip();
    expect(screen.queryByText("Drag a planned day to move it.")).not.toBeInTheDocument();
    await planDay(WED, pushId);
    expect(await screen.findByText("Drag a planned day to move it.")).toBeInTheDocument();
  });

  it("moves a planned day onto a free day", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    await waitFor(() => expect(dayButton(WED).textContent).toContain("•"));
    dragDay(WED, FRI);

    await waitFor(async () => expect(await getDay(FRI)).toMatchObject({ routine_id: pushId, status: "planned" }));
    await waitFor(async () => expect(await getDay(WED)).toBeUndefined());
    expect(await screen.findByText(`Moved Push to ${short(FRI)}.`)).toBeInTheDocument();
    await waitFor(() => expect(dayButton(WED).textContent).toBe("W14"));
  });

  it("swaps two planned days", async () => {
    await planDay(WED, pushId);
    await planDay(SAT, legsId);
    await renderStrip();
    await waitFor(() => expect(dayButton(SAT).textContent).toContain("•"));
    dragDay(WED, SAT);

    await waitFor(async () => expect(await getDay(SAT)).toMatchObject({ routine_id: pushId }));
    await waitFor(async () => expect(await getDay(WED)).toMatchObject({ routine_id: legsId, status: "planned" }));
    expect(await screen.findByText(`Swapped ${short(WED)} and ${short(SAT)}.`)).toBeInTheDocument();
  });

  it("ignores a drop on a past day", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    await waitFor(() => expect(dayButton(WED).textContent).toContain("•"));
    dragDay(WED, MON);
    await new Promise((r) => setTimeout(r, 20));
    expect(await getDay(MON)).toBeUndefined();
    expect(await getDay(WED)).toMatchObject({ routine_id: pushId, status: "planned" });
  });

  it("does not drag a day that is not planned", async () => {
    await planDay(WED, pushId);
    await db.planned_days.update((await getDay(WED))!.id, { status: "done", workout_id: "w1" });
    await renderStrip();
    await waitFor(() => expect(dayButton(WED).textContent).toContain("✓"));
    dragDay(WED, FRI);
    await new Promise((r) => setTimeout(r, 20));
    expect(await getDay(FRI)).toBeUndefined();
    expect(await getDay(WED)).toMatchObject({ status: "done" });
  });

  it("a short press still opens the day panel", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    const btn = dayButton(WED);
    fireEvent.pointerDown(btn, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(btn, { pointerId: 1, clientX: 12, clientY: 11 });
    fireEvent.pointerUp(btn, { pointerId: 1, clientX: 12, clientY: 11 });
    fireEvent.click(btn);
    expect(await screen.findByText(/Planned:/)).toHaveTextContent("Planned: Push");
  });
});

describe("WeekStrip auto-fill from my split", () => {
  const openAutoFill = () => fireEvent.click(screen.getByRole("button", { name: "Auto-fill from my split" }));

  it("asks for a routine when there are none", async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    await renderStrip();
    openAutoFill();
    expect(await screen.findByText("Create a routine first to auto-fill your week.")).toBeInTheDocument();
  });

  it("lays the split across the default gym days, from today on", async () => {
    await saveSplit({ name: "PPL", days: [{ name: "Push", muscles: [] }, { name: "Pull", muscles: [] }, { name: "Legs", muscles: [] }] });
    await renderStrip();
    openAutoFill();
    expect(await screen.findByText("Order: Push, Pull, Legs")).toBeInTheDocument();
    // Three split days give Mon, Wed, Fri; Monday is past.
    const fill = await screen.findByRole("button", { name: "Fill 2 days" });
    fireEvent.click(fill);

    await waitFor(async () => expect(await getDay(WED)).toMatchObject({ routine_id: pushId, status: "planned" }));
    await waitFor(async () => expect(await getDay(FRI)).toMatchObject({ routine_id: pullId, status: "planned" }));
    expect(await getDay(MON)).toBeUndefined();
    expect(await screen.findByText("Planned 2 days.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Fill / })).not.toBeInTheDocument();
  });

  it("lets the user pick gym days and keeps planned days", async () => {
    await planDay(THU, legsId);
    await renderStrip();
    openAutoFill();
    // No split: routines are used oldest first.
    expect(await screen.findByText(/No split set/)).toHaveTextContent("Push, Pull, Legs");
    for (const k of [THU, SAT, SUN]) fireEvent.click(screen.getByRole("button", { name: short(k) }));
    expect(screen.getByRole("button", { name: short(THU) })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Fill 4 days" }));

    // Wed, Fri, Sat, Sun get Push, Pull, Legs, Push; Thursday keeps Legs.
    await waitFor(async () => expect(await getDay(SUN)).toMatchObject({ routine_id: pushId }));
    expect(await getDay(WED)).toMatchObject({ routine_id: pushId });
    expect(await getDay(FRI)).toMatchObject({ routine_id: pullId });
    expect(await getDay(SAT)).toMatchObject({ routine_id: legsId });
    expect(await getDay(THU)).toMatchObject({ routine_id: legsId });
  });

  it("says so when no gym day is free", async () => {
    await planDay(WED, pushId);
    await planDay(FRI, pushId);
    await renderStrip();
    openAutoFill();
    expect(await screen.findByText("No free gym days left this week.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fill 0 days" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("No free gym days left this week.")).not.toBeInTheDocument();
  });
});
